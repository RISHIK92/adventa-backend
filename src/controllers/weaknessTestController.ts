import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import {
  AnswerStatus,
  Prisma,
  type Question,
  type UserSubtopicPerformance,
  type UserTestInstanceSummary,
  type UserTopicPerformance,
} from "@prisma/client";
import { getTopicAccuracyComparisonData } from "../utils/getAccuracyComparisonData.js";
import { generateWeaknessPrompt } from "../ai/prompts/weaknessPrompt.js";

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
    const { examId } = req.query;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!examId) return res.status(400).json({ error: "Exam ID is required" });

    const exam = await prisma.exam.findUnique({
      where: { id: parseInt(examId as string) },
    });
    if (!exam) return res.status(404).json({ error: "Exam not found" });

    // Fetch the 15 weakest TOPICS with at least 5 attempts
    const weakestTopics = await prisma.userTopicPerformance.findMany({
      where: {
        userId: uid,
        totalAttempted: { gte: 5 },
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
      // Need at least 2 weak topics
      return res.status(400).json({
        error:
          "Not enough performance data to generate a weakness test. Practice more topics in this exam.",
      });
    }

    // Group by subjects
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
    // Estimate: ~4 questions per weak topic
    const expectedQuestions = totalTopicsForTest * 4;

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

    // 1. Find all weak topics for the user in this exam
    const allUserTopicPerformance = await prisma.userTopicPerformance.findMany({
      where: {
        userId: uid,
        totalAttempted: { gte: 10 },
        topic: { subject: { examId: exam.id } },
      },
      orderBy: { accuracyPercent: "asc" },
    });

    // 2. Group these topics by subject
    const topicsBySubject = new Map<number, typeof allUserTopicPerformance>();
    allUserTopicPerformance.forEach((perf: any) => {
      const subjectId = perf.topic.subjectId;
      if (!topicsBySubject.has(subjectId)) {
        topicsBySubject.set(subjectId, []);
      }
      topicsBySubject.get(subjectId)?.push(perf);
    });

    // 3. Select the top 1 or 2 weakest topics from each subject
    const selectedTopicsForTest: {
      topicId: number;
      accuracyPercentBefore: number;
      totalAttemptedBefore: number;
    }[] = [];
    topicsBySubject.forEach((performancesInSubject) => {
      // Take the top 2 weakest topics from each subject, max
      const topWeakestTopics = performancesInSubject.slice(0, 2);
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
        error: "Not enough data to generate a weakness test.",
      });
    }

    // 4. For each selected weak topic, find its 2-3 weakest subtopics
    const selectedTopicIds = selectedTopicsForTest.map((t) => t.topicId);
    const weakSubtopicsWithinTopics =
      await prisma.userSubtopicPerformance.findMany({
        where: {
          userId: uid,
          subtopic: { topicId: { in: selectedTopicIds } },
        },
        orderBy: { accuracyPercent: "asc" },
      });

    const subtopicsToQuery = new Map<number, number[]>(); // Map<topicId, subtopicId[]>
    selectedTopicIds.forEach((topicId) => {
      const subtopicsInTopic = weakSubtopicsWithinTopics
        .filter((sub: any) => sub.subtopic.topicId === topicId)
        .slice(0, 3); // Take the 3 weakest subtopics from the weak topic
      if (subtopicsInTopic.length > 0) {
        subtopicsToQuery.set(
          topicId,
          subtopicsInTopic.map((s) => s.subtopicId)
        );
      }
    });

    // 5. Fetch candidate questions from these weakest subtopics
    const subtopicIdsToFetch = Array.from(subtopicsToQuery.values()).flat();
    const candidateQuestions = await prisma.question.findMany({
      where: { subtopicId: { in: subtopicIdsToFetch } },
    });

    // 6. Assemble the test: 2 questions per subtopic
    let allQuestionsForTest: Question[] = [];
    subtopicsToQuery.forEach((subtopicIds, topicId) => {
      subtopicIds.forEach((subtopicId) => {
        const questionsInSubtopic = candidateQuestions.filter(
          (q) => q.subtopicId === subtopicId
        );
        const shuffled = questionsInSubtopic.sort(() => 0.5 - Math.random());
        allQuestionsForTest.push(...shuffled.slice(0, 2)); // 2 questions per weak subtopic
      });
    });

    if (allQuestionsForTest.length < 5) {
      // Ensure a meaningful test length
      return res.status(400).json({
        error: "Could not find enough unique questions for your weak areas.",
      });
    }

    allQuestionsForTest = [...new Set(allQuestionsForTest)].sort(
      () => 0.5 - Math.random()
    ); // Shuffle final list

    // 7. Create the test instance and snapshots in a transaction
    const totalQuestionsInTest = allQuestionsForTest.length;
    let testInstance: UserTestInstanceSummary | undefined;

    await prisma.$transaction(async (tx) => {
      testInstance = await tx.userTestInstanceSummary.create({
        data: {
          userId: uid,
          examId: exam.id,
          testName: `${exam.name} - Topic Weakness Test`,
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

      // Link questions to the test
      await tx.testInstanceQuestion.createMany({
        data: allQuestionsForTest.map((q, index) => ({
          testInstanceId: testInstance!.id,
          questionId: q.id,
          order: index + 1,
        })),
      });

      // Create TOPIC snapshots
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
export const getTestDataForTaking = async (req: Request, res: Response) => {
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
    const { answers, timeTakenSec } = req.body as {
      answers: AnswerPayload[];
      timeTakenSec: number;
    };

    // --- PHASE 1: VALIDATION & PRE-CHECKS ---
    if (!uid) {
      return res
        .status(401)
        .json({ success: false, error: "User not authenticated" });
    }
    if (!testInstanceId || !answers || !Array.isArray(answers)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid request payload." });
    }

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
      include: { subtopic: { select: { topicId: true } } }, // Get topicId for each question
    });
    const questionsMap = new Map<number, (typeof questions)[0]>(
      questions.map((q) => [q.id, q])
    );

    // Get all unique subtopic and topic IDs involved in this submission
    const subtopicIds = [...new Set(questions.map((q) => q.subtopicId))];
    const topicIds = [...new Set(questions.map((q) => q.subtopic.topicId))];

    // Fetch current performance for all affected entities in parallel
    const [currentSubtopicPerfs, currentTopicPerfs] = await Promise.all([
      prisma.userSubtopicPerformance.findMany({
        where: { userId: uid, subtopicId: { in: subtopicIds } },
      }),
      prisma.userTopicPerformance.findMany({
        where: { userId: uid, topicId: { in: topicIds } },
      }),
    ]);

    const subtopicPerfMap = new Map<number, UserSubtopicPerformance>(
      currentSubtopicPerfs.map((p) => [p.subtopicId, p])
    );
    const topicPerfMap = new Map<number, UserTopicPerformance>(
      currentTopicPerfs.map((p) => [p.topicId, p])
    );

    // --- PHASE 3: ANSWER PROCESSING & AGGREGATION ---
    let totalCorrect = 0;
    let totalIncorrect = 0;
    const userTestAnswerPayloads: Prisma.UserTestAnswerCreateManyInput[] = [];

    // Maps to aggregate performance changes before writing to DB
    const subtopicUpdates = new Map<
      number,
      { attempted: number; correct: number; time: number }
    >();
    const topicUpdates = new Map<
      number,
      { attempted: number; correct: number; time: number }
    >();

    for (const answer of answers) {
      const question = questionsMap.get(answer.questionId);
      if (!question || !question.subtopicId || !question.subtopic.topicId)
        continue;

      const subtopicId = question.subtopicId;
      const topicId = question.subtopic.topicId;
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

        // Aggregate updates for subtopic
        const subUpdate = subtopicUpdates.get(subtopicId) || {
          attempted: 0,
          correct: 0,
          time: 0,
        };
        subUpdate.attempted++;
        subUpdate.correct += isCorrect ? 1 : 0;
        subUpdate.time += time;
        subtopicUpdates.set(subtopicId, subUpdate);

        // Aggregate updates for its parent topic
        const topUpdate = topicUpdates.get(topicId) || {
          attempted: 0,
          correct: 0,
          time: 0,
        };
        topUpdate.attempted++;
        topUpdate.correct += isCorrect ? 1 : 0;
        topUpdate.time += time;
        topicUpdates.set(topicId, topUpdate);
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
    const transactionPromises: Prisma.PrismaPromise<any>[] = [];

    // Promise 1: Create all UserTestAnswer records at once
    transactionPromises.push(
      prisma.userTestAnswer.createMany({ data: userTestAnswerPayloads })
    );

    // Promise 2: Upsert all UserSubtopicPerformance records
    for (const [subtopicId, update] of subtopicUpdates.entries()) {
      const currentPerf = subtopicPerfMap.get(subtopicId);
      const newTotalAttempted =
        (currentPerf?.totalAttempted || 0) + update.attempted;
      const newTotalCorrect = (currentPerf?.totalCorrect || 0) + update.correct;
      const newTotalTimeTaken =
        (currentPerf?.totalTimeTakenSec || 0) + update.time;

      transactionPromises.push(
        prisma.userSubtopicPerformance.upsert({
          where: { userId_subtopicId: { userId: uid, subtopicId } },
          create: {
            userId: uid,
            subtopicId,
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

    // Promise 3: Upsert all UserTopicPerformance records
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
          timeTakenSec: timeTakenSec || 0,
          completedAt: new Date(),
        },
      })
    );

    // Execute all promises in a single transaction
    await prisma.$transaction(transactionPromises);

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
          // Fetch all answers for this test
          orderBy: { question: { id: "asc" } },
          include: {
            question: {
              // For each answer, include the full question details
              include: {
                subtopic: {
                  // And its parent subtopic
                  include: {
                    topic: {
                      // And its parent topic
                      include: {
                        subject: true, // And its parent subject
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!testInstance)
      return res.status(404).json({ error: "Test instance not found" });

    // Define the shape of our final, nested data structure
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
    }
    interface SubjectAnalysis {
      totalQuestions: number;
      correctAnswers: number;
      accuracy: string;
      topics: { [topicName: string]: TopicAnalysis };
    }

    const initialValue: { [subjectName: string]: SubjectAnalysis } = {};

    // Use reduce to transform the flat list of answers into the desired nested structure
    const subjectAnalysis = testInstance.answers.reduce((acc, answer) => {
      const question = answer.question;
      const subtopic = question?.subtopic;
      const topic = subtopic?.topic;
      const subject = topic?.subject;

      // Gracefully skip if any part of the hierarchy is missing
      if (!question || !subtopic || !topic || !subject) return acc;

      const subjectName = subject.name;
      const topicName = topic.name;
      const subtopicName = subtopic.name;

      // Initialize structures if they don't exist
      if (!acc[subjectName])
        acc[subjectName] = {
          totalQuestions: 0,
          correctAnswers: 0,
          accuracy: "0",
          topics: {},
        };
      if (!acc[subjectName].topics[topicName])
        acc[subjectName].topics[topicName] = {
          totalQuestions: 0,
          correctAnswers: 0,
          accuracy: "0",
          subtopics: {},
        };
      if (!acc[subjectName].topics[topicName].subtopics[subtopicName])
        acc[subjectName].topics[topicName].subtopics[subtopicName] = {
          totalQuestions: 0,
          correctAnswers: 0,
          accuracy: "0",
          questions: [],
        };

      const subjectData = acc[subjectName];
      const topicData = subjectData.topics[topicName];
      const subtopicData = topicData.subtopics[subtopicName];

      // Increment counts at all levels
      subjectData.totalQuestions++;
      topicData.totalQuestions++;
      subtopicData.totalQuestions++;
      if (answer.isCorrect) {
        subjectData.correctAnswers++;
        topicData.correctAnswers++;
        subtopicData.correctAnswers++;
      }

      // Add the detailed question result
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
    }, initialValue);

    // A final loop to calculate accuracy percentages at each level
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

    // Re-use the new topic-based comparison logic
    const comparisonData = await getTopicAccuracyComparisonData(
      testInstanceId,
      uid
    ); // Assume this helper is created
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
  generateWeaknessTest,
  submitWeaknessTest,
  getWeaknessTestResults,
  getAccuracyComparison,
  getWeaknessTestSummary,
};
