import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import {
  AnswerStatus,
  Prisma,
  DifficultyLevel,
  type Question,
  type UserSubtopicPerformance,
  type UserTestInstanceSummary,
  type UserTopicPerformance,
} from "@prisma/client";
import { getTopicAccuracyComparisonData } from "../utils/getAccuracyComparisonData.js";
import { generateWeaknessPrompt } from "../ai/prompts/weaknessPrompt.js";
import { redisClient } from "../config/redis.js";

const router = Router();

interface AnswerPayload {
  questionId: number;
  userAnswer: string | null;
  timeTaken: number;
}

// ROUTE 1: GET /weakness/exams - Get list of exams available for a weakness test
const getAvailableExams = async (req: Request, res: Response) => {
  try {
    const uid = req.user;
    if (!uid) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const allExams = await prisma.exam.findMany({
      select: {
        id: true,
        name: true,
      },
      orderBy: {
        id: "asc",
      },
    });

    res.json({
      success: true,
      data: {
        availableExams: allExams,
        message:
          allExams.length > 0
            ? "Select an exam to preview your weakness test."
            : "No exams are configured in the system.",
      },
    });
  } catch (error) {
    console.error("Error getting available exams:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ROUTE 2: GET /weakness/topics - Get preview of weakest topics (MODIFIED)
const getWeakestTopics = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { examId } = req.params;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!examId) return res.status(400).json({ error: "Exam ID is required" });

    const exam = await prisma.exam.findUnique({
      where: { id: parseInt(examId as string) },
    });
    if (!exam) return res.status(404).json({ error: "Exam not found" });

    // Fetch the 6 weakest TOPICS with at least 3 attempts
    const weakestTopics = await prisma.userTopicPerformance.findMany({
      where: {
        userId: uid,
        totalAttempted: { gte: 3 },
        topic: { subject: { examId: exam.id } },
      },
      select: {
        accuracyPercent: true,
        topic: {
          select: {
            name: true,
            id: true,
            subject: { select: { name: true } },
          },
        },
      },
      orderBy: { accuracyPercent: "asc" },
      take: 10,
    });

    if (weakestTopics.length < 2) {
      return res.status(400).json({
        error:
          "Not enough performance data to generate a weakness test. Practice more topics in this exam.",
      });
    }

    const subjectGroups: {
      [key: string]: { topicId: number; topicName: string; accuracy: number }[];
    } = {};
    weakestTopics.forEach((p: any) => {
      const subjectName = p.topic.subject.name;
      if (!subjectGroups[subjectName]) subjectGroups[subjectName] = [];
      subjectGroups[subjectName].push({
        topicId: p.topic.id,
        topicName: p.topic.name,
        accuracy: Number(p.accuracyPercent),
      });
    });

    const totalTopicsForTest = Object.values(subjectGroups).reduce(
      (sum, topics) => sum + topics.length,
      0
    );
    // Estimate: ~3 questions per weak topic
    const expectedQuestions = totalTopicsForTest * 3;

    res.json({
      success: true,
      data: {
        examId: exam.id,
        examName: exam.name,
        expectedQuestions,
        estimatedTimeMinutes: Math.ceil((expectedQuestions * 120) / 60),
        subjectBreakdown: subjectGroups,
      },
    });
  } catch (error) {
    console.error("Error getting weakest topics preview:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ROUTE 3: POST /weakness/generate - Generate the test (HEAVILY MODIFIED)
const generateWeaknessTest = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { examId } = req.body;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!examId) return res.status(400).json({ error: "Exam ID is required" });

    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) return res.status(404).json({ error: "Exam not found" });

    // === STEP 1: Find the 2 weakest topics per subject (based on overall accuracy) ===
    const allUserTopicPerformance = await prisma.userTopicPerformance.findMany({
      where: {
        userId: uid,
        totalAttempted: { gte: 3 },
        topic: { subject: { examId: exam.id } },
      },
      include: {
        topic: { include: { subject: true } },
      },
      orderBy: { accuracyPercent: "asc" },
    });

    const topicsBySubject = allUserTopicPerformance.reduce((acc, perf) => {
      const subjectId = perf.topic.subject.id;
      if (!acc[subjectId]) acc[subjectId] = [];
      acc[subjectId].push(perf);
      return acc;
    }, {} as Record<number, typeof allUserTopicPerformance>);

    const selectedTopicsForTest: {
      topicId: number;
      accuracyPercentBefore: number;
      totalAttemptedBefore: number;
    }[] = [];
    Object.values(topicsBySubject).forEach((performancesInSubject) => {
      const topWeakestTopics = performancesInSubject.slice(0, 2); // Take top 2
      topWeakestTopics.forEach((perf) => {
        selectedTopicsForTest.push({
          topicId: perf.topicId,
          accuracyPercentBefore: Number(perf.accuracyPercent),
          totalAttemptedBefore: perf.totalAttempted,
        });
      });
    });

    if (selectedTopicsForTest.length === 0) {
      return res.status(400).json({
        error: "Not enough performance data to generate a weakness test.",
      });
    }

    const selectedTopicIds = selectedTopicsForTest.map((t) => t.topicId);

    // === STEP 2: Fetch the difficulty breakdown for these selected weak topics ===
    const difficultyPerformances =
      await prisma.userTopicDifficultyPerformance.findMany({
        where: {
          userId: uid,
          topicId: { in: selectedTopicIds },
        },
      });

    // === STEP 3: Determine the question strategy for each topic ===
    const questionStrategyByTopic = new Map<
      number,
      Record<DifficultyLevel, number>
    >();
    const difficultyOrder: DifficultyLevel[] = [
      DifficultyLevel.Easy,
      DifficultyLevel.Medium,
      DifficultyLevel.Hard,
    ];

    for (const topicId of selectedTopicIds) {
      const perfsForTopic = difficultyPerformances.filter(
        (p) => p.topicId === topicId
      );
      const accuracies = new Map<DifficultyLevel, number>();
      perfsForTopic.forEach((p) =>
        accuracies.set(p.difficultyLevel, Number(p.accuracyPercent))
      );

      // Sort the difficulties by the user's accuracy in them, from weakest to strongest.
      const sortedDifficulties = [...difficultyOrder].sort((a, b) => {
        const accA = accuracies.get(a) ?? 101;
        const accB = accuracies.get(b) ?? 101;
        return accA - accB;
      });

      const [weakest, middle, strongest] = sortedDifficulties;

      // The strategy is: 2 questions from their weakest difficulty, 1 from their next weakest.
      const strategy: Record<DifficultyLevel, number> = {
        Easy: 0,
        Medium: 0,
        Hard: 0,
        Elite: 0,
      };
      {
        if (weakest) {
          strategy[weakest] = (strategy[weakest] || 0) + 2;
        }
        if (middle) {
          strategy[middle] = (strategy[middle] || 0) + 1;
        }
      }

      questionStrategyByTopic.set(topicId, strategy);
    }

    // === STEP 4: Build a dynamic query to fetch all candidate questions at once ===
    const queryConditions: Prisma.QuestionWhereInput[] = [];
    for (const [topicId, strategy] of questionStrategyByTopic.entries()) {
      for (const [difficulty, count] of Object.entries(strategy)) {
        if (count > 0) {
          queryConditions.push({
            subtopic: { topicId: topicId },
            humanDifficultyLevel: difficulty as DifficultyLevel,
          });
        }
      }
    }

    if (queryConditions.length === 0) {
      return res.status(400).json({
        error: "Could not determine a question strategy for your weaknesses.",
      });
    }

    const candidateQuestions = await prisma.question.findMany({
      where: { OR: queryConditions },
    });

    // === STEP 5: Assemble the final test according to the strategy ===
    let allQuestionsForTest: Question[] = [];
    for (const [topicId, strategy] of questionStrategyByTopic.entries()) {
      for (const [difficulty, count] of Object.entries(strategy)) {
        if (count > 0) {
          const questionsInBucket = candidateQuestions.filter(
            (q: any) =>
              q.subtopic.topicId === topicId &&
              q.humanDifficultyLevel === difficulty
          );
          const shuffled = questionsInBucket.sort(() => 0.5 - Math.random());
          allQuestionsForTest.push(...shuffled.slice(0, count));
        }
      }
    }

    if (allQuestionsForTest.length < 5) {
      return res.status(400).json({
        error: "Could not find enough unique questions for your weak areas.",
      });
    }

    allQuestionsForTest = [...new Set(allQuestionsForTest)].sort(
      () => 0.5 - Math.random()
    );

    // === STEP 6: Create the test instance in a transaction (No changes here) ===
    const totalQuestionsInTest = allQuestionsForTest.length;
    let testInstance: UserTestInstanceSummary | undefined;

    await prisma.$transaction(async (tx) => {
      testInstance = await tx.userTestInstanceSummary.create({
        data: {
          userId: uid,
          examId: exam.id,
          testName: `${exam.name} - Targeted Weakness Test`,
          testType: "weakness",
          score: 0,
          totalMarks: totalQuestionsInTest * exam.marksPerCorrect,
          totalQuestions: totalQuestionsInTest,
          numUnattempted: totalQuestionsInTest,
          numCorrect: 0,
          numIncorrect: 0,
          timeTakenSec: 0,
        },
      });

      await tx.testInstanceQuestion.createMany({
        data: allQuestionsForTest.map((q, index) => ({
          testInstanceId: testInstance!.id,
          questionId: q.id,
          order: index + 1,
        })),
      });

      await tx.testTopicSnapshot.createMany({
        data: selectedTopicsForTest.map((p) => ({
          testInstanceId: testInstance!.id,
          topicId: p.topicId,
          accuracyPercentBefore: p.accuracyPercentBefore,
          totalAttemptedBefore: p.totalAttemptedBefore,
        })),
      });
    });

    res
      .status(201)
      .json({ success: true, data: { testInstanceId: testInstance!.id } });
  } catch (error) {
    console.error("Error generating topic weakness test:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * ROUTE: GET /weakness/test/:testInstanceId
 * Securely fetches the data required to take a specific test.
 */
const getTestDataForTaking = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    if (!uid) {
      return res
        .status(401)
        .json({ success: false, error: "User not authenticated" });
    }
    if (!testInstanceId) {
      return res
        .status(400)
        .json({ success: false, error: "Test instance ID is required" });
    }

    const testInstance = await prisma.userTestInstanceSummary.findFirst({
      where: {
        id: testInstanceId,
        userId: uid,
      },
      include: {
        exam: true,
        testQuestions: {
          include: {
            question: {
              include: {
                subtopic: true,
              },
            },
          },
          orderBy: { order: "asc" },
        },
      },
    });

    if (!testInstance) {
      return res
        .status(404)
        .json({ success: false, error: "Test instance not found." });
    }

    const { exam, testQuestions } = testInstance;

    if (testInstance.completedAt) {
      return res.status(403).json({
        success: false,
        error: "This test has already been completed.",
      });
    }

    const avgTimePerQuestion =
      (exam.durationInMinutes * 60) / exam.totalQuestions;

    res.json({
      success: true,
      data: {
        testInstanceId: testInstance.id,
        testName: testInstance.testName,
        totalQuestions: testInstance.totalQuestions,
        totalMarks: testInstance.totalMarks,
        timeLimit: Math.round(testInstance.totalQuestions * avgTimePerQuestion),
        instructions: [
          `This test focuses on your weakest topics in ${exam.name}.`,
          `Each correct answer carries ${exam.marksPerCorrect} marks.`,
          `Each incorrect answer will result in a penalty of ${exam.negativeMarksPerIncorrect} mark(s).`,
          `Unattempted questions will receive ${exam.marksPerUnattempted} marks.`,
        ],
        questions: testQuestions.map((tq: any) => ({
          id: tq.question.id,
          questionNumber: tq.order,
          question: tq.question.question,
          options: tq.question.options.map((opt: any, optIndex: any) => ({
            label: String.fromCharCode(65 + optIndex),
            value: opt,
          })),
          imageUrl: tq.question.imageUrl,
          topic: tq.question.subtopic?.name || "General",
          difficulty: "medium",
          // IMPORTANT: Do NOT send correctAnswer or explanation to the client when they are taking the test
        })),
      },
    });
  } catch (error) {
    console.error("Error fetching test data for taking:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// ROUTE 5: POST /weakness/submit/:testInstanceId - Submit the completed test
const submitWeaknessTest = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    // --- PHASE 1: VALIDATION & PRE-CHECKS ---
    if (!uid) {
      return res
        .status(401)
        .json({ success: false, error: "User not authenticated" });
    }
    if (!testInstanceId) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid request payload." });
    }

    const redisKey = `progress:${testInstanceId}`;
    const savedProgress = await redisClient.hGetAll(redisKey);

    if (Object.keys(savedProgress).length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "No progress found to submit." });
    }

    const totalTimeTakenSec = parseFloat(savedProgress._totalTime || "0");

    delete savedProgress._totalTime;

    const answers = Object.entries(savedProgress).map(([questionId, data]) => {
      const { answer, time } = JSON.parse(data);
      return {
        questionId: Number(questionId),
        userAnswer: answer,
        timeTaken: Math.round(time),
      };
    });

    const testInstance = await prisma.userTestInstanceSummary.findUnique({
      where: { id: testInstanceId, userId: uid },
      include: { exam: true },
    });

    if (!testInstance || !testInstance.exam) {
      return res.status(404).json({
        success: false,
        error: "Test instance or associated exam not found.",
      });
    }
    if (testInstance.completedAt) {
      await redisClient.del(redisKey);
      return res.status(403).json({
        success: false,
        error: "This test has already been submitted.",
      });
    }

    // --- PHASE 2: DATA FETCHING & PREPARATION ---
    const examBlueprint = testInstance.exam;
    const questionIds = answers.map((a) => a.questionId);

    const questions = await prisma.question.findMany({
      where: { id: { in: questionIds } },
      include: { subtopic: { select: { topicId: true } } },
    });
    const questionsMap = new Map(questions.map((q) => [q.id, q]));

    const topicIds = [...new Set(questions.map((q) => q.subtopic.topicId))];

    const [currentTopicPerfs, currentTopicDifficultyPerfs] = await Promise.all([
      prisma.userTopicPerformance.findMany({
        where: { userId: uid, topicId: { in: topicIds } },
      }),
      prisma.userTopicDifficultyPerformance.findMany({
        where: { userId: uid, topicId: { in: topicIds } },
      }),
    ]);

    const topicPerfMap = new Map(currentTopicPerfs.map((p) => [p.topicId, p]));
    const topicDifficultyPerfMap = new Map(
      currentTopicDifficultyPerfs.map((p) => [
        `${p.topicId}-${p.difficultyLevel}`,
        p,
      ])
    );

    // --- PHASE 3: ANSWER PROCESSING & AGGREGATION ---
    let totalCorrect = 0;
    let totalIncorrect = 0;
    const userTestAnswerPayloads = [];

    const topicUpdates = new Map();
    const topicDifficultyUpdates = new Map();

    for (const answer of answers) {
      const question = questionsMap.get(answer.questionId);
      if (!question || !question.subtopic?.topicId) continue;

      const topicId = question.subtopic.topicId;
      const difficultyLevel = question.humanDifficultyLevel;
      let isCorrect = false;
      let status: AnswerStatus = AnswerStatus.Unattempted;
      const userAnswer = answer.userAnswer?.trim() ?? null;

      if (userAnswer) {
        isCorrect =
          userAnswer.toUpperCase() ===
          question.correctOption.trim().toUpperCase();
        status = isCorrect ? AnswerStatus.Correct : AnswerStatus.Incorrect;
        if (isCorrect) totalCorrect++;
        else totalIncorrect++;

        const time = answer.timeTaken || 0;

        const topUpdate = topicUpdates.get(topicId) || {
          attempted: 0,
          correct: 0,
          time: 0,
        };
        topUpdate.attempted++;
        topUpdate.correct += isCorrect ? 1 : 0;
        topUpdate.time += time;
        topicUpdates.set(topicId, topUpdate);

        const difficultyKey = `${topicId}-${difficultyLevel}`;
        const diffUpdate = topicDifficultyUpdates.get(difficultyKey) || {
          attempted: 0,
          correct: 0,
          time: 0,
        };
        diffUpdate.attempted++;
        diffUpdate.correct += isCorrect ? 1 : 0;
        diffUpdate.time += time;
        topicDifficultyUpdates.set(difficultyKey, diffUpdate);
      }

      userTestAnswerPayloads.push({
        testInstanceId: testInstanceId,
        questionId: question.id,
        userId: uid,
        userAnswer: answer.userAnswer || null,
        isCorrect: isCorrect,
        status: status,
        timeTakenSec: answer.timeTaken || 0,
      });
    }

    const totalAttempted = totalCorrect + totalIncorrect;
    const totalUnattempted = testInstance.totalQuestions - totalAttempted;

    // --- PHASE 4: DATABASE TRANSACTION ---
    const transactionPromises = [];

    // Promise 1: Create UserTestAnswer records
    transactionPromises.push(
      prisma.userTestAnswer.createMany({ data: userTestAnswerPayloads })
    );

    // Promise 2: Upsert UserTopicPerformance records (no change to this loop)
    for (const [topicId, update] of topicUpdates.entries()) {
      const currentPerf = topicPerfMap.get(topicId);
      const newTotalAttempted =
        (currentPerf?.totalAttempted || 0) + update.attempted;
      const newTotalCorrect = (currentPerf?.totalCorrect || 0) + update.correct;
      const newTotalTimeTaken =
        (currentPerf?.totalTimeTakenSec || 0) + update.time;
      transactionPromises.push(
        prisma.userTopicPerformance.upsert({
          where: { userId_topicId: { userId: uid, topicId } },
          create: {
            userId: uid,
            topicId,
            totalAttempted: update.attempted,
            totalCorrect: update.correct,
            totalIncorrect: update.attempted - update.correct,
            totalTimeTakenSec: update.time,
            accuracyPercent:
              update.attempted > 0
                ? (update.correct / update.attempted) * 100
                : 0,
            avgTimePerQuestionSec:
              update.attempted > 0 ? update.time / update.attempted : 0,
          },
          update: {
            totalAttempted: { increment: update.attempted },
            totalCorrect: { increment: update.correct },
            totalIncorrect: { increment: update.attempted - update.correct },
            totalTimeTakenSec: { increment: update.time },
            accuracyPercent:
              newTotalAttempted > 0
                ? (newTotalCorrect / newTotalAttempted) * 100
                : 0,
            avgTimePerQuestionSec:
              newTotalAttempted > 0 ? newTotalTimeTaken / newTotalAttempted : 0,
          },
        })
      );
    }

    for (const [key, update] of topicDifficultyUpdates.entries()) {
      const [topicIdStr, difficultyLevel] = key.split("-");
      const topicId = parseInt(topicIdStr);

      const currentPerf = topicDifficultyPerfMap.get(key);
      const newTotalAttempted =
        (currentPerf?.totalAttempted || 0) + update.attempted;
      const newTotalCorrect = (currentPerf?.totalCorrect || 0) + update.correct;
      const newTotalTimeTaken =
        (currentPerf?.totalTimeTakenSec || 0) + update.time;

      transactionPromises.push(
        prisma.userTopicDifficultyPerformance.upsert({
          where: {
            userId_topicId_difficultyLevel: {
              userId: uid,
              topicId,
              difficultyLevel,
            },
          },
          create: {
            userId: uid,
            topicId,
            difficultyLevel,
            totalAttempted: update.attempted,
            totalCorrect: update.correct,
            totalTimeTakenSec: update.time,
            accuracyPercent:
              update.attempted > 0
                ? (update.correct / update.attempted) * 100
                : 0,
            avgTimePerQuestionSec:
              update.attempted > 0 ? update.time / update.attempted : 0,
          },
          update: {
            totalAttempted: { increment: update.attempted },
            totalCorrect: { increment: update.correct },
            totalTimeTakenSec: { increment: update.time },
            accuracyPercent:
              newTotalAttempted > 0
                ? (newTotalCorrect / newTotalAttempted) * 100
                : 0,
            avgTimePerQuestionSec:
              newTotalAttempted > 0 ? newTotalTimeTaken / newTotalAttempted : 0,
          },
        })
      );
    }

    // Promise 4: Update the final test summary
    const finalScore =
      totalCorrect * examBlueprint.marksPerCorrect -
      totalIncorrect * examBlueprint.negativeMarksPerIncorrect;
    transactionPromises.push(
      prisma.userTestInstanceSummary.update({
        where: { id: testInstanceId },
        data: {
          score: finalScore,
          numCorrect: totalCorrect,
          numIncorrect: totalIncorrect,
          numUnattempted: totalUnattempted,
          timeTakenSec: Math.round(totalTimeTakenSec),
          completedAt: new Date(),
        },
      })
    );

    await prisma.$transaction(transactionPromises);

    await redisClient.del(redisKey);

    // --- PHASE 5: RESPOND TO USER ---
    const accuracyPercent =
      totalAttempted > 0 ? (totalCorrect / totalAttempted) * 100 : 0;
    res.status(200).json({
      success: true,
      data: {
        summary: {
          testInstanceId,
          score: finalScore,
          totalMarks: testInstance.totalMarks,
          accuracyPercentage: accuracyPercent.toFixed(2),
          totalCorrect,
          totalIncorrect,
          totalUnattempted,
        },
      },
    });
  } catch (error) {
    console.error("Error submitting weakness test:", error);
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return res.status(404).json({
        success: false,
        error: "Test instance to update was not found.",
      });
    }
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

interface QuestionResult {
  questionId: number;
  question: string;
  userAnswer: string | null;
  correctOption: string;
  solution: string;
  isCorrect: boolean;
  timeTakenSec: number;
}

interface SubtopicAnalysis {
  totalQuestions: number;
  correctAnswers: number;
  accuracy: string;
  questions: QuestionResult[];
}

interface TopicAnalysis {
  totalQuestions: number;
  correctAnswers: number;
  accuracy: string;
  subtopics: { [subtopicName: string]: SubtopicAnalysis };
  difficultyBreakdown: {
    [difficulty: string]: {
      totalQuestions: number;
      correctAnswers: number;
      accuracy: string;
    };
  };
}

interface SubjectAnalysis {
  totalQuestions: number;
  correctAnswers: number;
  accuracy: string;
  topics: { [topicName: string]: TopicAnalysis };
}

// ROUTE 6: GET /weakness/results/:testInstanceId - Get detailed test results
const getWeaknessTestResults = async (req: Request, res: Response) => {
  try {
    const { testInstanceId } = req.params;
    const { uid } = req.user;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!testInstanceId)
      return res.status(400).json({ error: "Test instance ID is required" });

    const testInstance = await prisma.userTestInstanceSummary.findUnique({
      where: { id: testInstanceId, userId: uid },
      include: {
        answers: {
          orderBy: { question: { id: "asc" } },
          include: {
            question: {
              // We need humanDifficultyLevel from here
              include: {
                subtopic: {
                  include: { topic: { include: { subject: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (!testInstance)
      return res.status(404).json({ error: "Test instance not found" });

    const initialValue: { [key: string]: SubjectAnalysis } = {};

    const subjectAnalysis = testInstance.answers.reduce(
      (acc: any, answer: any) => {
        const question = answer.question;
        const subtopic = question?.subtopic;
        const topic = subtopic?.topic;
        const subject = topic?.subject;

        const difficulty = question?.humanDifficultyLevel;

        if (!question || !subtopic || !topic || !subject || !difficulty) {
          return acc;
        }

        const subjectName: string = subject.name;
        const topicName: string = topic.name;
        const subtopicName: string = subtopic.name;

        if (!acc[subjectName])
          acc[subjectName] = {
            totalQuestions: 0,
            correctAnswers: 0,
            accuracy: "0",
            topics: {},
          };

        if (!acc[subjectName].topics[topicName]) {
          acc[subjectName].topics[topicName] = {
            totalQuestions: 0,
            correctAnswers: 0,
            accuracy: "0",
            subtopics: {},
            difficultyBreakdown: {},
          };
        }
        if (!acc[subjectName].topics[topicName].subtopics[subtopicName])
          acc[subjectName].topics[topicName].subtopics[subtopicName] = {
            totalQuestions: 0,
            correctAnswers: 0,
            accuracy: "0",
            questions: [],
          };

        if (
          !acc[subjectName].topics[topicName].difficultyBreakdown[difficulty]
        ) {
          acc[subjectName].topics[topicName].difficultyBreakdown[difficulty] = {
            totalQuestions: 0,
            correctAnswers: 0,
            accuracy: "0",
          };
        }

        const subjectData = acc[subjectName];
        const topicData = subjectData.topics[topicName];
        if (!topicData) return;
        const subtopicData = topicData.subtopics[subtopicName];
        if (!subtopicData) return;
        const difficultyData = topicData.difficultyBreakdown[difficulty];
        if (!difficultyData) return;

        subjectData.totalQuestions++;
        topicData.totalQuestions++;
        subtopicData.totalQuestions++;
        difficultyData.totalQuestions++;

        if (answer.isCorrect) {
          subjectData.correctAnswers++;
          topicData.correctAnswers++;
          subtopicData.correctAnswers++;
          difficultyData.correctAnswers++;
        }

        // Add detailed question result (no change here)
        subtopicData.questions.push({
          questionId: question.id,
          question: question.question,
          userAnswer: answer.userAnswer,
          correctOption: question.correctOption,
          solution: question.solution,
          isCorrect: answer.isCorrect,
          timeTakenSec: answer.timeTakenSec,
        });

        return acc;
      },
      initialValue
    );

    for (const subjectName in subjectAnalysis) {
      const subjectData = subjectAnalysis[subjectName];
      subjectData.accuracy = (
        subjectData.totalQuestions > 0
          ? (subjectData.correctAnswers / subjectData.totalQuestions) * 100
          : 0
      ).toFixed(2);
      for (const topicName in subjectData.topics) {
        const topicData = subjectData.topics[topicName];
        topicData.accuracy = (
          topicData.totalQuestions > 0
            ? (topicData.correctAnswers / topicData.totalQuestions) * 100
            : 0
        ).toFixed(2);

        for (const difficulty in topicData.difficultyBreakdown) {
          const diffData = topicData.difficultyBreakdown[difficulty];
          diffData.accuracy = (
            diffData.totalQuestions > 0
              ? (diffData.correctAnswers / diffData.totalQuestions) * 100
              : 0
          ).toFixed(2);
        }

        for (const subtopicName in topicData.subtopics) {
          const subtopicData = topicData.subtopics[subtopicName];
          subtopicData.accuracy = (
            subtopicData.totalQuestions > 0
              ? (subtopicData.correctAnswers / subtopicData.totalQuestions) *
                100
              : 0
          ).toFixed(2);
        }
      }
    }

    res.json({
      success: true,
      data: {
        testSummary: {
          testInstanceId: testInstance.id,
          testName: testInstance.testName,
          score: testInstance.score,
          totalMarks: testInstance.totalMarks,
          totalCorrect: testInstance.numCorrect,
          totalIncorrect: testInstance.numIncorrect,
          totalUnattempted: testInstance.numUnattempted,
          completedAt: testInstance.completedAt,
        },
        subjectAnalysis: subjectAnalysis,
      },
    });
  } catch (error) {
    console.error("Error getting weakness test results:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ROUTE 7: NEW - GET /weakness/results/:testInstanceId/comparison
const getAccuracyComparison = async (req: Request, res: Response) => {
  try {
    const { testInstanceId } = req.params;
    const { uid } = req.user;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!testInstanceId)
      return res.status(400).json({ error: "Test instance ID is required" });

    // 1. Fetch the "before" snapshots for TOPICS from when the test was created
    const snapshots = await prisma.testTopicSnapshot.findMany({
      where: { testInstanceId: testInstanceId },
      include: { topic: { select: { name: true } } }, // Include topic name for the response
    });

    if (snapshots.length === 0) {
      return res.status(404).json({
        success: false,
        error:
          "No topic comparison data found for this test. It might be an older test or had no topics to snapshot.",
      });
    }

    // 2. Get the IDs of all topics that were part of this test
    const topicIds = snapshots.map((s: any) => s.topicId);

    // 3. Fetch the LATEST performance data for ONLY those topics for the current user
    const latestPerformance = await prisma.userTopicPerformance.findMany({
      where: {
        userId: uid,
        topicId: { in: topicIds },
      },
    });

    // 4. Create a Map for efficient O(1) lookups
    const latestPerformanceMap = new Map(
      latestPerformance.map((p) => [p.topicId, p])
    );

    // 5. Compare "before" and "after" for each topic
    const comparisonResults = snapshots.map((snapshot: any) => {
      const afterPerf = latestPerformanceMap.get(snapshot.topicId);

      // The "after" accuracy is the latest record; if none exists, it means no new questions were answered, so it's same as before.
      const accuracyAfter = afterPerf
        ? afterPerf.accuracyPercent
        : snapshot.accuracyPercentBefore;

      return {
        topicId: snapshot.topicId,
        topicName: snapshot.topic.name,
        accuracyBefore: Number(snapshot.accuracyPercentBefore).toFixed(2),
        accuracyAfter: Number(accuracyAfter).toFixed(2),
        change: (
          Number(accuracyAfter) - Number(snapshot.accuracyPercentBefore)
        ).toFixed(2),
      };
    });

    res.json({
      success: true,
      data: comparisonResults,
    });
  } catch (error) {
    console.error("Error getting topic accuracy comparison:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

import { geminiApi } from "../ai/models/gemini.js";

// ROUTE 8: NEW - GET /weakness/results/:testInstanceId/summary
const getWeaknessTestSummary = async (req: Request, res: Response) => {
  try {
    const { testInstanceId } = req.params;
    const { uid } = req.user;
    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!testInstanceId)
      return res.status(401).json({ error: "Test not found" });

    const comparisonData = await getTopicAccuracyComparisonData(
      testInstanceId,
      uid
    );
    if (!comparisonData || comparisonData.length === 0) {
      return res.status(404).json({ error: "No comparison data found." });
    }

    const testInstance = await prisma.userTestInstanceSummary.findUnique({
      where: { id: testInstanceId, userId: uid },
      include: { exam: true },
    });
    if (!testInstance)
      return res.status(404).json({ error: "Test instance not found." });

    const userDataString = comparisonData
      .map(
        (d: any) =>
          `- Topic: "${d.topicName}", Accuracy Before: ${d.accuracyBefore}%, Accuracy After: ${d.accuracyAfter}%`
      )
      .join("\n");

    const { systemPrompt, userPrompt } = generateWeaknessPrompt(
      testInstance,
      userDataString
    );
    const summary = await geminiApi(systemPrompt, userPrompt);

    res.json({ success: true, data: { summary } });
  } catch (error) {
    console.error("Error generating topic-based LLM summary:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export {
  getAvailableExams,
  getWeakestTopics,
  getTestDataForTaking,
  generateWeaknessTest,
  submitWeaknessTest,
  getWeaknessTestResults,
  getAccuracyComparison,
  getWeaknessTestSummary,
};
