import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { Prisma, AnswerStatus, DifficultyLevel } from "@prisma/client";
import { redisClient } from "../config/redis.js";
import {
  updateGlobalSubtopicAverages,
  updateGlobalTopicAverages,
  updateUserOverallAverage,
  updateGlobalSubjectAverages,
  updateDailyPerformanceAndStreak,
} from "../utils/globalStatsUpdater.js";

/**
 * ROUTE: POST /revision-test/generate
 * Generates a new revision test based on user's mistakes and weakest topics.
 */
const generateRevisionTest = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    if (!uid) {
      return res
        .status(401)
        .json({ success: false, error: "User not authenticated." });
    }

    const { examId, questionCount } = req.body;
    const validQuestionCounts = [10, 20, 30, 60];

    if (!examId || !validQuestionCounts.includes(questionCount)) {
      return res.status(400).json({
        success: false,
        error: "Valid examId and questionCount (10, 20, 30, 60) are required.",
      });
    }

    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) {
      return res.status(404).json({ success: false, error: "Exam not found." });
    }

    const revisionQuestions = new Map<
      number,
      Prisma.QuestionGetPayload<true>
    >();

    // 1. Fetch from Mistake Bank (Incorrectly answered questions)
    const mistakeBankQuestions = await prisma.userTestAnswer.findMany({
      where: {
        userId: uid,
        isCorrect: false,
        testInstance: { examId: parseInt(examId) },
      },
      select: {
        question: true,
      },
      distinct: ["questionId"],
      take: Math.ceil(questionCount * 0.6), // 60% from mistake bank
    });
    mistakeBankQuestions.forEach((item) =>
      revisionQuestions.set(item.question.id, item.question)
    );

    // 2. Fetch from Weakest Topics
    if (revisionQuestions.size < questionCount) {
      const weakestTopics = await prisma.userTopicPerformance.findMany({
        where: {
          userId: uid,
          topic: { subject: { examId: parseInt(examId) } },
          totalAttempted: { gt: 0 },
        },
        orderBy: { accuracyPercent: "asc" },
        take: 5, // Consider top 5 weakest topics
      });

      if (weakestTopics.length > 0) {
        const questionsFromWeakTopics = await prisma.question.findMany({
          where: {
            subtopic: { topicId: { in: weakestTopics.map((t) => t.topicId) } },
            id: { notIn: Array.from(revisionQuestions.keys()) },
          },
          take: questionCount - revisionQuestions.size,
        });
        questionsFromWeakTopics.forEach((q) => revisionQuestions.set(q.id, q));
      }
    }

    // 3. Fill remaining with random questions from the exam
    if (revisionQuestions.size < questionCount) {
      const remainingCount = questionCount - revisionQuestions.size;
      const randomQuestions = await prisma.question.findMany({
        where: {
          examSession: { examId: parseInt(examId) },
          id: { notIn: Array.from(revisionQuestions.keys()) },
        },
        take: remainingCount,
      });
      randomQuestions.forEach((q) => revisionQuestions.set(q.id, q));
    }

    const finalQuestions = Array.from(revisionQuestions.values());

    if (finalQuestions.length < questionCount) {
      return res.status(400).json({
        success: false,
        error: `Could not generate enough questions. Found only ${finalQuestions.length}.`,
      });
    }

    const shuffledQuestions = finalQuestions.sort(() => 0.5 - Math.random());
    const timeLimitMinutes = questionCount * 1.5; // 90 seconds per question on average

    const testInstance = await prisma.$transaction(async (tx) => {
      const newTestInstance = await tx.userTestInstanceSummary.create({
        data: {
          userId: uid,
          examId: exam.id,
          testName: `Revision Test (${questionCount} Qs)`,
          testType: "revision", // Using 'weakness' as the revision test type
          score: 0,
          totalMarks: questionCount * exam.marksPerCorrect,
          totalQuestions: questionCount,
          numUnattempted: questionCount,
          numCorrect: 0,
          numIncorrect: 0,
          timeTakenSec: timeLimitMinutes * 60,
        },
      });

      await tx.testInstanceQuestion.createMany({
        data: shuffledQuestions.map((q, index) => ({
          testInstanceId: newTestInstance.id,
          questionId: q.id,
          order: index + 1,
        })),
      });

      return newTestInstance;
    });

    res.status(201).json({
      success: true,
      message: "Revision test generated successfully.",
      data: { testInstanceId: testInstance.id },
    });
  } catch (error) {
    console.error("Error generating revision test:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};

/**
 * ROUTE: GET /revision-test/test/:testInstanceId
 * Fetches the data required for a user to take a specific revision test.
 */
const getRevisionTestDataForTaking = async (req: Request, res: Response) => {
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
      where: { id: testInstanceId, userId: uid, testType: "weakness" },
      include: {
        testQuestions: {
          include: { question: true },
          orderBy: { order: "asc" },
        },
      },
    });

    if (!testInstance) {
      return res
        .status(404)
        .json({ success: false, error: "Revision test instance not found." });
    }

    if (testInstance.completedAt) {
      return res.status(403).json({
        success: false,
        error: "This test has already been completed.",
      });
    }

    res.json({
      success: true,
      data: {
        testInstanceId: testInstance.id,
        testName: testInstance.testName,
        totalQuestions: testInstance.totalQuestions,
        timeLimit: testInstance.timeTakenSec,
        questions: testInstance.testQuestions.map((tq) => {
          const optionsObject = tq.question.options as Prisma.JsonObject;
          const formattedOptions = Object.entries(optionsObject).map(
            ([label, value]) => ({
              label: String(label),
              value: String(value),
            })
          );

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
    console.error("Error fetching revision test data:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/**
 * ROUTE: POST /revision-test/submit/:testInstanceId
 * Submits answers for the revision test and calculates the score.
 */
const submitRevisionTest = async (req: Request, res: Response) => {
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

    // Extract total time and parse answers from Redis hash
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

    // --- PHASE 2: DATA FETCHING & PREPARATION ---
    const testInstance = await prisma.userTestInstanceSummary.findUnique({
      where: { id: testInstanceId, userId: uid },
      include: { exam: true }, // Include exam for scoring rules
    });

    if (!testInstance || !testInstance.exam) {
      return res
        .status(404)
        .json({ success: false, error: "Test instance not found." });
    }
    if (testInstance.completedAt) {
      await redisClient.del(redisKey); // Clean up stale redis key
      return res.status(403).json({
        success: false,
        error: "This test has already been submitted.",
      });
    }

    const examBlueprint = testInstance.exam;
    const questionIds = answers.map((a) => a.questionId);

    const questions = await prisma.question.findMany({
      where: { id: { in: questionIds } },
      include: {
        subtopic: {
          select: {
            id: true,
            topicId: true,
            topic: { select: { subjectId: true } },
          },
        },
      },
    });

    const questionsMap = new Map(questions.map((q) => [q.id, q]));
    const topicToSubjectMap = new Map<number, number>();
    questions.forEach((q) => {
      if (q.subtopic?.topic) {
        topicToSubjectMap.set(q.subtopic.topicId, q.subtopic.topic.subjectId);
      }
    });

    const topicIds = [...new Set(questions.map((q) => q.subtopic.topicId))];
    const subtopicIds = [...new Set(questions.map((q) => q.subtopic.id))];
    const subjectIds = [...new Set(topicToSubjectMap.values())];

    // Pre-fetch all current performance records for efficiency
    const [
      currentTopicPerfs,
      currentSubtopicPerfs,
      currentTopicDifficultyPerfs,
      currentSubjectPerfs,
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
      prisma.userSubjectPerformance.findMany({
        where: { userId: uid, subjectId: { in: subjectIds } },
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
    const subjectPerfMap = new Map(
      currentSubjectPerfs.map((p) => [p.subjectId, p])
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
      if (!question?.subtopic?.topicId) continue;

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

        // Aggregate topic performance updates
        const topUpdate = topicUpdates.get(topicId) || {
          attempted: 0,
          correct: 0,
          time: 0,
        };
        topUpdate.attempted++;
        topUpdate.correct += isCorrect ? 1 : 0;
        topUpdate.time += time;
        topicUpdates.set(topicId, topUpdate);

        // Aggregate subtopic performance updates
        const subTopUpdate = subtopicUpdates.get(subtopicId) || {
          attempted: 0,
          correct: 0,
          time: 0,
        };
        subTopUpdate.attempted++;
        subTopUpdate.correct += isCorrect ? 1 : 0;
        subTopUpdate.time += time;
        subtopicUpdates.set(subtopicId, subTopUpdate);

        // Aggregate difficulty-specific performance updates
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

    // Promise 1: Create all UserTestAnswer records
    transactionPromises.push(
      prisma.userTestAnswer.createMany({ data: userTestAnswerPayloads })
    );

    // Aggregate topic updates into subject updates
    const subjectUpdates = new Map<
      number,
      { attempted: number; correct: number; time: number }
    >();
    for (const [topicId, update] of topicUpdates.entries()) {
      const subjectId = topicToSubjectMap.get(topicId);
      if (subjectId) {
        const subjectUpdate = subjectUpdates.get(subjectId) || {
          attempted: 0,
          correct: 0,
          time: 0,
        };
        subjectUpdate.attempted += update.attempted;
        subjectUpdate.correct += update.correct;
        subjectUpdate.time += update.time;
        subjectUpdates.set(subjectId, subjectUpdate);
      }
    }

    // Promise 2: Upsert UserSubjectPerformance records
    for (const [subjectId, update] of subjectUpdates.entries()) {
      const currentPerf = subjectPerfMap.get(subjectId);
      const newTotalAttempted =
        (currentPerf?.totalAttempted || 0) + update.attempted;
      const newTotalCorrect = (currentPerf?.totalCorrect || 0) + update.correct;
      const newTotalTimeTaken =
        (currentPerf?.totalTimeTakenSec || 0) + update.time;
      transactionPromises.push(
        prisma.userSubjectPerformance.upsert({
          where: { userId_subjectId: { userId: uid, subjectId } },
          create: {
            userId: uid,
            subjectId,
            totalAttempted: update.attempted,
            totalCorrect: update.correct,
            totalIncorrect: update.attempted - update.correct,
            totalTimeTakenSec: update.time,
            accuracyPercent: (update.correct / update.attempted) * 100,
            avgTimePerQuestionSec: update.time / update.attempted,
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

    // Promise 3: Upsert UserTopicPerformance records
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
            accuracyPercent: (update.correct / update.attempted) * 100,
            avgTimePerQuestionSec: update.time / update.attempted,
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

    // Promise 4: Upsert UserSubtopicPerformance records
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
            accuracyPercent: (update.correct / update.attempted) * 100,
            avgTimePerQuestionSec: update.time / update.attempted,
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

    // Promise 5: Upsert UserTopicDifficultyPerformance records
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
            accuracyPercent: (update.correct / update.attempted) * 100,
            avgTimePerQuestionSec: update.time / update.attempted,
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

    // Calculate final score based on exam rules
    const finalScore =
      totalCorrect * examBlueprint.marksPerCorrect -
      totalIncorrect * examBlueprint.negativeMarksPerIncorrect;

    // Promise 6: Update the main test instance summary
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

    // --- PHASE 5: BACKGROUND AGGREGATE UPDATES ---
    await redisClient.del(redisKey);

    void updateGlobalTopicAverages(topicIds);
    void updateGlobalSubtopicAverages(subtopicIds);
    void updateGlobalSubjectAverages(subjectIds);
    void updateUserOverallAverage(uid);
    void updateDailyPerformanceAndStreak(uid, {
      totalAttempted: totalAttempted,
      totalCorrect: totalCorrect,
      timeTakenSec: Math.round(totalTimeTakenSec),
    });

    // --- PHASE 6: RESPOND TO USER ---
    res.status(200).json({
      success: true,
      data: {
        summary: {
          testInstanceId,
          score: finalScore,
          totalMarks: testInstance.totalMarks,
          totalCorrect,
          totalIncorrect,
          totalUnattempted,
        },
      },
    });
  } catch (error) {
    console.error("Error submitting revision test:", error);
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
 * ROUTE: GET /revision-test/results/:testInstanceId
 * Fetches the detailed results and performance breakdown of a completed revision test.
 */
const getRevisionTestResults = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    // --- 1. Validation ---
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

    // --- 2. Fetch Core Test Data in a Single Query ---
    // This query is optimized to get all related data at once.
    const testInstance = await prisma.userTestInstanceSummary.findFirst({
      where: {
        id: testInstanceId,
        userId: uid,
        testType: "weakness", // The type we assigned for Revision Tests
        completedAt: { not: null }, // Ensure the test has actually been submitted
      },
      include: {
        answers: true, // User's answers for this specific test
        testQuestions: {
          orderBy: { order: "asc" }, // Get questions in their original order
          include: {
            question: {
              // Include the full details for each question
              include: {
                subtopic: {
                  select: {
                    // Navigate up to the topic for performance aggregation
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
      },
    });

    if (!testInstance) {
      return res.status(404).json({
        success: false,
        error: "Completed revision test result not found for this user.",
      });
    }

    // --- 3. Process and Aggregate Data ---

    // Create a Map for fast answer lookups (O(1) complexity)
    const answersMap = new Map(
      testInstance.answers.map((answer) => [answer.questionId, answer])
    );

    // Use a Map to efficiently aggregate performance data per topic.
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
        // Initialize the accumulator for this topic if it's the first time we see it.
        if (!topicPerformanceAggregator.has(topic.id)) {
          topicPerformanceAggregator.set(topic.id, {
            topicName: topic.name,
            totalAttempted: 0,
            totalCorrect: 0,
            totalTimeTakenSec: 0,
          });
        }

        // Increment the stats for the current topic.
        const currentTopicPerf = topicPerformanceAggregator.get(topic.id)!;
        currentTopicPerf.totalAttempted += 1;
        currentTopicPerf.totalTimeTakenSec += timeTaken;
        if (status === AnswerStatus.Correct) {
          currentTopicPerf.totalCorrect += 1;
        }
      }

      // --- Formatting Logic ---
      // Safely format question options from JSONB to a structured array
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

      // Return a fully detailed question object for the frontend
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

    // --- 4. Calculate Final Metrics for Topic Performance ---
    const topicPerformance = Array.from(
      topicPerformanceAggregator.values()
    ).map((perf) => {
      const accuracy =
        perf.totalAttempted > 0
          ? (perf.totalCorrect / perf.totalAttempted) * 100
          : 0;
      const avgTime =
        perf.totalAttempted > 0
          ? perf.totalTimeTakenSec / perf.totalAttempted
          : 0;

      return {
        topicName: perf.topicName,
        totalAttempted: perf.totalAttempted,
        totalCorrect: perf.totalCorrect,
        accuracyPercent: parseFloat(accuracy.toFixed(2)),
        avgTimePerQuestionSec: parseFloat(avgTime.toFixed(2)),
      };
    });

    // --- 5. Construct and Send the Final JSON Payload ---
    res.status(200).json({
      success: true,
      data: {
        summary: {
          testInstanceId: testInstance.id,
          testName: testInstance.testName,
          score: testInstance.score,
          totalMarks: testInstance.totalMarks,
          correctQuestions: `${testInstance.numCorrect}/${testInstance.totalQuestions}`,
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
    console.error("Error fetching revision test results:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

export {
  generateRevisionTest,
  getRevisionTestDataForTaking,
  submitRevisionTest,
  getRevisionTestResults,
};
