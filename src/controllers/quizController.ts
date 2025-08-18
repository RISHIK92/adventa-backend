import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { Prisma, DifficultyLevel, AnswerStatus } from "@prisma/client";
import { redisClient } from "../config/redis.js";
import {
  updateGlobalSubtopicAverages,
  updateGlobalTopicAverages,
  updateUserOverallAverage,
} from "../utils/globalStatsUpdater.js";

/**
 * ROUTE: GET /custom-quiz/dashboard/:examId
 * Fetches a list of previously completed custom quizzes for the user.
 */
const getCustomQuizDashboard = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { examId } = req.params;

    if (!uid) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    if (!examId) {
      return res.status(400).json({ error: "Exam ID is required" });
    }

    const pastTests = await prisma.userTestInstanceSummary.findMany({
      where: {
        userId: uid,
        examId: parseInt(examId),
        testType: "custom",
        completedAt: { not: null },
      },
      select: {
        id: true,
        testName: true,
        score: true,
        totalMarks: true,
        completedAt: true,
        totalQuestions: true,
      },
      orderBy: {
        completedAt: "desc",
      },
    });

    res.json({
      success: true,
      data: {
        pastTests,
      },
    });
  } catch (error) {
    console.error("Error getting custom quiz dashboard:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * ROUTE: GET /custom-quiz/options/:examId
 * Fetches the necessary data (like subjects) to populate the custom quiz creation modal.
 */
const getCustomQuizOptions = async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;

    if (!examId) {
      return res.status(400).json({ error: "Exam ID is required" });
    }

    const subjects = await prisma.subject.findMany({
      where: {
        examId: parseInt(examId),
      },
      select: {
        id: true,
        name: true,
      },
      orderBy: {
        name: "asc",
      },
    });

    res.json({
      success: true,
      data: {
        subjects,
      },
    });
  } catch (error) {
    console.error("Error getting custom quiz options:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * ROUTE: POST /custom-quiz/generate
 * Generates a new custom test based on user criteria.
 */
const generateCustomQuiz = async (req: Request, res: Response) => {
  try {
    // --- 1. Authentication & Input Validation ---
    const { uid } = req.user;
    if (!uid) {
      return res.status(401).json({ error: "User not authenticated." });
    }

    const {
      examId,
      subjectIds, // Expecting an array of subject IDs
      difficultyLevels, // Expecting an array of strings like ['easy', 'medium', 'hard']
      questionCount,
      timeLimitMinutes,
    } = req.body;

    if (!examId || !questionCount || !timeLimitMinutes) {
      return res.status(400).json({
        error:
          "Missing required fields: examId, questionCount, and timeLimitMinutes are required.",
      });
    }

    // --- 2. Verify Exam Exists ---
    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) {
      return res.status(404).json({ error: "Exam not found." });
    }

    // --- 3. Build Prisma Query ---
    const whereClause: Prisma.QuestionWhereInput = {
      // Base filter: questions must belong to the specified exam
      examSession: {
        examId: examId,
      },
    };

    // **FIXED LOGIC**: Conditionally add subject filter
    // This assumes the relationship: Question -> Subtopic -> Topic -> Subject
    if (subjectIds && subjectIds.length > 0) {
      whereClause.subtopic = {
        topic: {
          subject: {
            id: { in: subjectIds },
          },
        },
      };
    }

    // Conditionally add difficulty filter
    if (difficultyLevels && difficultyLevels.length > 0) {
      whereClause.humanDifficultyLevel = { in: difficultyLevels };
    }

    // --- 4. Find Candidate Questions ---
    const candidateQuestions = await prisma.question.findMany({
      where: whereClause,
    });

    if (candidateQuestions.length < questionCount) {
      return res.status(400).json({
        error: `Not enough questions found for your criteria. Found only ${candidateQuestions.length}. Please broaden your search.`,
      });
    }

    // --- 5. Select & Shuffle Questions ---
    const shuffledQuestions = candidateQuestions.sort(
      () => 0.5 - Math.random()
    );
    const finalQuestions = shuffledQuestions.slice(0, questionCount);

    // --- 6. Create Test Instance in a Transaction ---
    const testName = `Custom Quiz (${questionCount} Questions)`;

    const testInstance = await prisma.$transaction(async (tx) => {
      const newTestInstance = await tx.userTestInstanceSummary.create({
        data: {
          userId: uid,
          examId: exam.id,
          testName: testName,
          testType: "custom",
          score: 0,
          totalMarks: questionCount,
          totalQuestions: questionCount,
          numUnattempted: questionCount,
          numCorrect: 0,
          numIncorrect: 0,
          timeTakenSec: timeLimitMinutes * 60,
        },
      });

      // Link the selected questions to this new test instance
      await tx.testInstanceQuestion.createMany({
        data: finalQuestions.map((q, index) => ({
          testInstanceId: newTestInstance.id,
          questionId: q.id,
          order: index + 1, // Store the question order
        })),
      });

      return newTestInstance;
    });

    res.status(201).json({
      success: true,
      message: "Custom quiz generated successfully.",
      data: {
        testInstanceId: testInstance.id,
      },
    });
  } catch (error) {
    console.error("Error generating custom quiz:", error);
    res
      .status(500)
      .json({ error: "Internal server error while generating the quiz." });
  }
};

/**
 * ROUTE: GET /custom-quiz/test/:testInstanceId
 * Securely fetches the data required for a user to take a specific custom quiz.
 * This is almost identical to the weakness test version.
 */
const getCustomQuizDataForTaking = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    if (!uid)
      return res
        .status(401)
        .json({ success: false, error: "User not authenticated" });
    if (!testInstanceId)
      return res
        .status(400)
        .json({ success: false, error: "Test instance ID is required" });

    const testInstance = await prisma.userTestInstanceSummary.findFirst({
      where: {
        id: testInstanceId,
        userId: uid,
        testType: "custom",
      },
      include: {
        exam: true,
        testQuestions: {
          include: {
            question: true,
          },
          orderBy: { order: "asc" },
        },
      },
    });

    if (!testInstance) {
      return res
        .status(404)
        .json({ success: false, error: "Custom quiz instance not found." });
    }

    if (testInstance.completedAt) {
      return res.status(403).json({
        success: false,
        error: "This quiz has already been completed.",
      });
    }

    const timeLimitInSeconds = testInstance.timeTakenSec;

    res.json({
      success: true,
      data: {
        testInstanceId: testInstance.id,
        testName: testInstance.testName,
        totalQuestions: testInstance.totalQuestions,
        totalMarks: testInstance.totalMarks,
        // For custom quizzes, the time limit is pre-set during generation.
        timeLimit: testInstance.timeTakenSec,
        questions: testInstance.testQuestions.map((tq) => {
          const optionsObject = tq.question.options as Prisma.JsonObject;
          let formattedOptions: { label: string; value: string }[] = [];
          if (
            optionsObject &&
            typeof optionsObject === "object" &&
            !Array.isArray(optionsObject)
          ) {
            formattedOptions = Object.entries(optionsObject).map(
              ([label, value]) => ({
                label: String(label),
                value: String(value),
              })
            );
          }

          return {
            id: tq.question.id,
            questionNumber: tq.order,
            question: tq.question.question,
            options: formattedOptions,
            imageUrl: tq.question.imageUrl,
          };
        }),
      },
    });
  } catch (error) {
    console.error("Error fetching custom quiz data:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// ROUTE: POST /custom-quiz/submit/:testInstanceId
const submitCustomQuiz = async (req: Request, res: Response) => {
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
      return res
        .status(404)
        .json({ success: false, error: "Test instance not found." });
    }
    if (testInstance.completedAt) {
      await redisClient.del(redisKey);
      return res.status(403).json({
        success: false,
        error: "This quiz has already been submitted.",
      });
    }

    // --- PHASE 2: DATA FETCHING & PREPARATION ---
    const examBlueprint = testInstance.exam;
    const questionIds = answers.map((a) => a.questionId);

    const questions = await prisma.question.findMany({
      where: { id: { in: questionIds } },
      include: { subtopic: { select: { id: true, topicId: true } } },
    });

    const questionsMap = new Map(questions.map((q) => [q.id, q]));

    const topicIds = [...new Set(questions.map((q) => q.subtopic.topicId))];
    const subtopicIds = [...new Set(questions.map((q) => q.subtopic.id))];

    const [
      currentTopicPerfs,
      currentSubtopicPerfs,
      currentTopicDifficultyPerfs,
    ] = await Promise.all([
      prisma.userTopicPerformance.findMany({
        where: { userId: uid, topicId: { in: topicIds } },
      }),
      prisma.userSubtopicPerformance.findMany({
        where: { userId: uid, subtopicId: { in: subtopicIds } },
      }),
      prisma.userTopicDifficultyPerformance.findMany({
        where: { userId: uid, topicId: { in: topicIds } },
      }),
    ]);

    const topicPerfMap = new Map(currentTopicPerfs.map((p) => [p.topicId, p]));
    const subtopicPerfMap = new Map(
      currentSubtopicPerfs.map((p) => [p.subtopicId, p])
    );
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
    const subtopicUpdates = new Map();
    const topicDifficultyUpdates = new Map();

    for (const answer of answers) {
      const question = questionsMap.get(answer.questionId);
      if (!question || !question.subtopic?.topicId) continue;

      const topicId = question.subtopic.topicId;
      const subtopicId = question.subtopic.id;
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

        const subTopUpdate = subtopicUpdates.get(subtopicId) || {
          attempted: 0,
          correct: 0,
          time: 0,
        };
        subTopUpdate.attempted++;
        subTopUpdate.correct += isCorrect ? 1 : 0;
        subTopUpdate.time += time;
        subtopicUpdates.set(subtopicId, subTopUpdate);

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

    transactionPromises.push(
      prisma.userTestAnswer.createMany({ data: userTestAnswerPayloads })
    );

    // Promise 2: Upsert UserTopicPerformance records (Full logic added)
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

    // Promise 3: Upsert UserSubtopicPerformance records (Full logic added)
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

    // Promise 4: Upsert UserTopicDifficultyPerformance records (Full logic added)
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
              difficultyLevel: difficultyLevel as DifficultyLevel,
            },
          },
          create: {
            userId: uid,
            topicId,
            difficultyLevel: difficultyLevel as DifficultyLevel,
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

    const finalScore = totalCorrect;
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

    // --- PHASE 5: BACKGROUND AGGREGATE UPDATES ---
    void updateGlobalTopicAverages(topicIds);
    void updateGlobalSubtopicAverages(subtopicIds);
    void updateUserOverallAverage(uid);

    // --- PHASE 6: RESPOND TO USER ---
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
    console.error("Error submitting custom quiz:", error);
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

/**
 * ROUTE: GET /custom-quiz/results/:testInstanceId
 * Fetches the detailed results and performance breakdown of a completed custom quiz.
 */
const getCustomQuizResults = async (req: Request, res: Response) => {
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

    // --- 1. Fetch the Core Test Data (Now with Topic Info) ---
    const testInstance = await prisma.userTestInstanceSummary.findFirst({
      where: {
        id: testInstanceId,
        userId: uid,
        testType: "custom",
        completedAt: { not: null },
      },
      include: {
        testQuestions: {
          orderBy: { order: "asc" },
          include: {
            // STEP 1: Enhance the query to include topic data for each question.
            question: {
              include: {
                subtopic: {
                  select: {
                    topic: {
                      select: {
                        id: true,
                        name: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        answers: true,
      },
    });

    if (!testInstance) {
      return res.status(404).json({
        success: false,
        error: "Completed quiz result not found for this user.",
      });
    }

    const answersMap = new Map(
      testInstance.answers.map((answer) => [answer.questionId, answer])
    );

    // --- 2. Aggregate Topic Performance while Structuring Question Data ---
    // Use a Map for efficient aggregation. Key: topicId, Value: performance object.
    const topicPerformanceAggregator = new Map<
      number,
      {
        topicName: string;
        totalAttempted: number;
        totalCorrect: number;
        totalTimeTakenSec: number;
      }
    >();

    const detailedQuestions = testInstance.testQuestions.map((tq) => {
      const question = tq.question;
      const userAnswer = answersMap.get(question.id);
      const status = userAnswer?.status || AnswerStatus.Unattempted;
      const timeTaken = userAnswer?.timeTakenSec || 0;

      // --- Aggregation Logic ---
      const topic = question.subtopic?.topic;
      if (topic && status !== AnswerStatus.Unattempted) {
        // Initialize the accumulator for this topic if it's the first time we've seen it.
        if (!topicPerformanceAggregator.has(topic.id)) {
          topicPerformanceAggregator.set(topic.id, {
            topicName: topic.name,
            totalAttempted: 0,
            totalCorrect: 0,
            totalTimeTakenSec: 0,
          });
        }

        const currentTopicPerf = topicPerformanceAggregator.get(topic.id)!;
        currentTopicPerf.totalAttempted += 1;
        currentTopicPerf.totalTimeTakenSec += timeTaken;
        if (status === AnswerStatus.Correct) {
          currentTopicPerf.totalCorrect += 1;
        }
      }

      // Format options (same as before)
      const optionsObject = question.options as Prisma.JsonObject;
      let formattedOptions: { label: string; value: string }[] = [];
      if (
        optionsObject &&
        typeof optionsObject === "object" &&
        !Array.isArray(optionsObject)
      ) {
        formattedOptions = Object.entries(optionsObject).map(
          ([label, value]) => ({
            label: String(label),
            value: String(value),
          })
        );
      }

      return {
        id: question.id,
        questionNumber: tq.order,
        question: question.question,
        options: formattedOptions,
        imageUrl: question.imageUrl,
        solution: question.solution,
        imagesolurl: question.imagesolurl,
        correctOption: question.correctOption,
        userAnswer: userAnswer?.userAnswer || null,
        status: status,
        timeTakenSec: timeTaken,
      };
    });

    // --- 3. Calculate Final Metrics for Topic Performance ---
    const topicPerformance = Array.from(
      topicPerformanceAggregator.entries()
    ).map(([topicId, perf]) => {
      const accuracy =
        perf.totalAttempted > 0
          ? (perf.totalCorrect / perf.totalAttempted) * 100
          : 0;
      const avgTime =
        perf.totalAttempted > 0
          ? perf.totalTimeTakenSec / perf.totalAttempted
          : 0;

      return {
        topicId: topicId,
        topicName: perf.topicName,
        totalAttempted: perf.totalAttempted,
        totalCorrect: perf.totalCorrect,
        accuracyPercent: parseFloat(accuracy.toFixed(2)),
        avgTimePerQuestionSec: parseFloat(avgTime.toFixed(2)),
      };
    });

    // --- 4. Send the Final JSON Payload ---
    res.status(200).json({
      success: true,
      data: {
        summary: {
          testInstanceId: testInstance.id,
          testName: testInstance.testName,
          score: testInstance.score,
          totalMarks: testInstance.totalMarks,
          totalQuestions: testInstance.totalQuestions,
          numCorrect: testInstance.numCorrect,
          numIncorrect: testInstance.numIncorrect,
          numUnattempted: testInstance.numUnattempted,
          timeTakenSec: testInstance.timeTakenSec,
          completedAt: testInstance.completedAt,
        },
        topicPerformance,
        questions: detailedQuestions,
      },
    });
  } catch (error) {
    console.error("Error fetching custom quiz results:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

export {
  getCustomQuizDashboard,
  getCustomQuizOptions,
  generateCustomQuiz,
  getCustomQuizDataForTaking,
  submitCustomQuiz,
  getCustomQuizResults,
};
