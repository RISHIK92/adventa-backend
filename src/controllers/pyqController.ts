// /controllers/pyqController.ts

import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { AnswerStatus, DifficultyLevel, Prisma } from "@prisma/client";

import { redisClient } from "../config/redis.js";
import {
  updateGlobalTopicAverages,
  updateGlobalSubtopicAverages,
  updateUserOverallAverage,
  updateGlobalSubjectAverages,
  updateDailyPerformanceAndStreak,
} from "../utils/globalStatsUpdater.js";

/**
 * ROUTE 1: GET /pyq/available/:examId
 * Fetches available PYQ years and shifts for a given exam, including user and total attempt counts.
 */
const getAvailablePyqs = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { examId } = req.params;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!examId) return res.status(400).json({ error: "Exam ID is required" });

    const numericExamId = parseInt(examId);

    // === CHANGE 1: Fetch the exam and its subjects in parallel with sessions ===
    const [examWithSubjects, sessions] = await Promise.all([
      prisma.exam.findUnique({
        where: { id: numericExamId },
        include: {
          subjects: {
            select: { name: true },
            orderBy: { id: "asc" },
          },
        },
      }),
      prisma.examSession.findMany({
        where: { examId: numericExamId },
        orderBy: { sessionDate: "desc" },
        include: {
          _count: {
            select: {
              testInstances: {
                where: { testType: "pyq", completedAt: { not: null } },
              },
            },
          },
        },
      }),
    ]);

    if (!examWithSubjects) {
      return res.status(404).json({ error: "Exam not found." });
    }
    const subjectNames = examWithSubjects.subjects.map((s) => s.name);

    // 2. Fetch the current user's attempt counts (No change here)
    const userAttempts = await prisma.userTestInstanceSummary.groupBy({
      by: ["examSessionId"],
      where: {
        userId: uid,
        testType: "pyq",
        examSessionId: { in: sessions.map((s) => s.id) },
      },
      _count: {
        id: true,
      },
    });

    const userAttemptsMap = new Map(
      userAttempts.map((a: any) => [a.examSessionId, a._count.id])
    );

    const groupedByYear = sessions.reduce((acc, session) => {
      const year = new Date(session.sessionDate ?? Date.now()).getFullYear();
      if (!acc[year]) acc[year] = [];
      acc[year].push({
        examSessionId: session.id,
        name: session.name,
        date: session.sessionDate,
        userAttempts: userAttemptsMap.get(session.id) || 0,
        totalAttempts: session._count.testInstances,
        subjects: subjectNames,
      });
      return acc;
    }, {} as Record<string, any[]>);

    const result = Object.entries(groupedByYear)
      .map(([year, shifts]) => ({ year: parseInt(year), shifts }))
      .sort((a, b) => b.year - a.year);

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error getting available PYQs:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * ROUTE: GET /pyq/latest-result/:examSessionId
 * Finds the ID of the most recently completed test instance for a specific PYQ session.
 */
const getLatestPyqResultId = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { examSessionId } = req.params;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!examSessionId)
      return res.status(400).json({ error: "Exam Session ID is required" });

    // Find the most recent test instance for this user and session that has been completed.
    const latestTestInstance = await prisma.userTestInstanceSummary.findFirst({
      where: {
        userId: uid,
        examSessionId: parseInt(examSessionId),
        testType: "pyq",
        completedAt: {
          not: null,
        },
      },
      orderBy: {
        completedAt: "desc",
      },
      select: {
        id: true,
      },
    });

    if (!latestTestInstance) {
      return res.status(404).json({
        success: false,
        error: "No completed test result found for this paper.",
      });
    }

    res.json({
      success: true,
      data: { testInstanceId: latestTestInstance.id },
    });
  } catch (error) {
    console.error("Error fetching latest PYQ result ID:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * ROUTE 2: POST /pyq/generate
 * Generates or retrieves a PYQ test instance for a user.
 * Ensures the same question order for all users.
 */
const generatePyqTest = async (req: Request, res: Response) => {
  const { uid } = req.user;
  const { examSessionId } = req.body;

  if (!uid) return res.status(401).json({ error: "User not authenticated" });
  if (!examSessionId)
    return res.status(400).json({ error: "Exam Session ID is required" });

  try {
    const examSession = await prisma.examSession.findUnique({
      where: { id: examSessionId },
      include: { exam: { include: { subjects: { orderBy: { id: "asc" } } } } },
    });

    if (!examSession)
      return res.status(404).json({ error: "Exam session not found" });

    // Check if the user already has an incomplete test for this session
    const existingInstance = await prisma.userTestInstanceSummary.findFirst({
      where: { userId: uid, examSessionId, completedAt: null, testType: "pyq" },
    });
    if (existingInstance) {
      return res.status(200).json({
        success: true,
        data: {
          testInstanceId: existingInstance.id,
          message: "Resuming existing test.",
        },
      });
    }

    let orderedQuestionIds: number[];

    await prisma.$transaction(async (tx) => {
      // 1. Find or create the master copy of the paper
      let paper = await tx.generatedPyqPaper.findUnique({
        where: { examSessionId },
      });

      if (paper) {
        // If paper already exists, use its question order
        orderedQuestionIds = paper.questionOrder as number[];
      } else {
        // If it's the first time, generate and save the paper
        const allQuestions = await tx.question.findMany({
          where: { examSessionId },
          include: { subtopic: { include: { topic: true } } },
        });

        // Order questions by subject, then shuffle within the subject
        orderedQuestionIds = [];
        for (const subject of examSession.exam.subjects) {
          const subjectQuestions = allQuestions
            .filter((q) => q.subtopic.topic.subjectId === subject.id)
            .sort(() => 0.5 - Math.random()); // Shuffle questions within the subject
          orderedQuestionIds.push(...subjectQuestions.map((q) => q.id));
        }

        await tx.generatedPyqPaper.create({
          data: {
            examSessionId,
            questionOrder: orderedQuestionIds,
          },
        });
      }

      // 2. Create the personalized test instance for the current user
      const testInstance = await tx.userTestInstanceSummary.create({
        data: {
          userId: uid,
          examId: examSession.examId,
          examSessionId: examSessionId,
          testName: `${examSession.name}`,
          testType: "pyq",
          totalQuestions: orderedQuestionIds.length,
          score: 0,
          totalMarks:
            orderedQuestionIds.length * examSession.exam.marksPerCorrect,
          numCorrect: 0,
          numIncorrect: 0,
          numUnattempted: orderedQuestionIds.length,
          timeTakenSec: 0,
        },
      });

      // 3. Link the ordered questions to the user's test instance
      await tx.testInstanceQuestion.createMany({
        data: orderedQuestionIds.map((questionId, index) => ({
          testInstanceId: testInstance.id,
          questionId,
          order: index + 1,
        })),
      });

      res
        .status(201)
        .json({ success: true, data: { testInstanceId: testInstance.id } });
    });
  } catch (error) {
    console.error("Error generating PYQ test:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getPyqBestScore = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { examSessionId } = req.params;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!examSessionId)
      return res.status(400).json({ error: "Exam Session ID is required" });

    const bestScoreResult = await prisma.userTestInstanceSummary.aggregate({
      _max: {
        score: true,
      },
      where: {
        userId: uid,
        examSessionId: parseInt(examSessionId),
        testType: "pyq",
        completedAt: {
          not: null,
        },
      },
    });

    const bestScore = bestScoreResult._max.score;

    if (bestScore === null) {
      return res.json({ success: true, data: { bestScore: null } });
    }

    res.json({ success: true, data: { bestScore } });
  } catch (error) {
    console.error("Error fetching PYQ best score:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * ROUTE: GET /pyq/percentile/:testInstanceId
 * Calculates a user's percentile based on a pre-defined score-to-percentile mapping
 * stored in the ExamSession table.
 */
const getPyqPercentile = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!testInstanceId)
      return res.status(400).json({ error: "Test Instance ID is required" });

    // Step 1: Get the user's test, but this time include the mapping from the related ExamSession
    const currentUserTest = await prisma.userTestInstanceSummary.findUnique({
      where: { id: testInstanceId, userId: uid },
      select: {
        score: true,
        examSession: {
          // Include the related exam session
          select: {
            scorePercentileMapping: true, // And select the new JSON field
          },
        },
      },
    });

    if (
      !currentUserTest ||
      !currentUserTest.examSession?.scorePercentileMapping
    ) {
      return res.status(404).json({
        success: false,
        error: "Percentile data is not available for this paper.",
      });
    }

    const userScore = currentUserTest.score;
    const mapping = currentUserTest.examSession
      .scorePercentileMapping as Record<string, number>;

    // Step 2: Find the correct percentile from the mapping

    // Get all the score thresholds from the mapping (e.g., ["300", "295", "290", ...])
    const scoreThresholds = Object.keys(mapping)
      .map(Number)
      .sort((a, b) => b - a);

    let matchedPercentile: number = 0;

    // Find the highest threshold that is less than or equal to the user's score
    for (const threshold of scoreThresholds) {
      if (userScore >= threshold) {
        const percentileForThreshold = mapping[String(threshold)];
        if (typeof percentileForThreshold === "number") {
          matchedPercentile = percentileForThreshold;
        }
        break;
      }
    }

    res.json({
      success: true,
      data: {
        score: userScore,
        percentile: matchedPercentile,
      },
    });
  } catch (error) {
    console.error("Error fetching PYQ percentile from mapping:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ROUTE 3: GET /pyq/test/:testInstanceId
const getPyqDataForTaking = async (req: Request, res: Response) => {
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
                subtopic: {
                  include: {
                    topic: {
                      include: {
                        subject: true,
                      },
                    },
                  },
                },
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

    if (!exam) {
      return;
      res
        .status(500)
        .json({ success: false, error: "Associated exam not found." });
    }

    if (testInstance.completedAt) {
      return res.status(403).json({
        success: false,
        error: "This test has already been completed.",
      });
    }

    const avgTimePerQuestion =
      (exam.durationInMinutes * 60) / exam.totalQuestions;
    const timeLimit = Math.round(
      testInstance.totalQuestions * avgTimePerQuestion
    );

    if (!testInstance.exam) {
      return;
    }
    const totalTimeLimitSec = testInstance.exam.durationInMinutes * 60;

    const redisKey = `progress:${testInstanceId}`;
    const timeSpentString = await redisClient.hGet(redisKey, "_totalTime");
    const timeSpentSec = parseInt(timeSpentString || "0", 10);

    const remainingTimeSec = totalTimeLimitSec - timeSpentSec;

    res.json({
      success: true,
      data: {
        testInstanceId: testInstance.id,
        testName: testInstance.testName,
        totalQuestions: testInstance.totalQuestions,
        totalMarks: testInstance.totalMarks,
        timeLimit: remainingTimeSec > 0 ? remainingTimeSec : 0,
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

          const subjectName =
            tq.question.subtopic?.topic?.subject?.name ?? "General";

          return {
            id: tq.question.id,
            questionNumber: tq.order,
            subject: subjectName,
            question: tq.question.question,
            options: formattedOptions,
            imageUrl: tq.question.imageUrl,
          };
        }),
      },
    });
  } catch (error) {
    console.error("Error fetching weakness test data:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// ROUTE 4: POST /pyq/submit/:testInstanceId - DEBUG VERSION
const submitPyqTest = async (req: Request, res: Response) => {
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

    console.log("Saved Progress:", savedProgress);

    const answers = Object.entries(savedProgress).map(([questionId, data]) => {
      const parsedData = JSON.parse(data);
      return {
        questionId: Number(questionId),
        userAnswer: parsedData.answer,
        timeTaken: Math.round(parsedData.time || 0),
        markedForReview: parsedData.markedForReview || false,
      };
    });

    console.log("Processed Answers:", answers);

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

    console.log("Test Instance:", {
      id: testInstance.id,
      totalQuestions: testInstance.totalQuestions,
      totalMarks: testInstance.totalMarks,
      examId: testInstance.exam?.id,
    });

    // --- PHASE 2: DATA FETCHING & PREPARATION ---
    const questionIds = answers.map((a) => a.questionId);
    console.log("Question IDs to fetch:", questionIds);

    const questions = await prisma.question.findMany({
      where: { id: { in: questionIds } },
      include: {
        subtopic: {
          select: {
            id: true,
            topicId: true,
            name: true,
            topic: {
              select: {
                id: true,
                subjectId: true,
              },
            },
          },
        },
      },
    });

    const questionsMap = new Map(questions.map((q) => [q.id, q]));

    const topicToSubjectMap = new Map<number, number>();
    questions.forEach((q) => {
      if (q.subtopic?.topic) {
        topicToSubjectMap.set(q.subtopic.topic.id, q.subtopic.topic.subjectId);
      }
    });

    // Check if questions have subtopics
    const questionsWithoutSubtopics = questions.filter((q) => !q.subtopic);
    if (questionsWithoutSubtopics.length > 0) {
      console.warn(
        "Questions without subtopics:",
        questionsWithoutSubtopics.map((q) => q.id)
      );
    }

    // Get unique IDs for topics and subtopics for later updates
    const topicIds = [
      ...new Set(
        questions
          .filter((q) => q.subtopic?.topicId)
          .map((q) => q.subtopic.topicId)
      ),
    ];
    const subtopicIds = [
      ...new Set(
        questions.filter((q) => q.subtopic?.id).map((q) => q.subtopic.id)
      ),
    ];

    const subjectIds = [...new Set(topicToSubjectMap.values())];

    console.log("Topic IDs:", topicIds);
    console.log("Subtopic IDs:", subtopicIds);

    // Only proceed with performance tracking if we have topic/subtopic data
    let currentTopicPerfs: any[] = [];
    let currentSubtopicPerfs: any[] = [];
    let currentTopicDifficultyPerfs: any[] = [];
    let currentSubjectPerfs: any[] = [];

    if (
      topicIds.length > 0 ||
      subtopicIds.length > 0 ||
      subjectIds.length > 0
    ) {
      [
        currentTopicPerfs,
        currentSubtopicPerfs,
        currentTopicDifficultyPerfs,
        currentSubjectPerfs,
      ] = await Promise.all([
        topicIds.length > 0
          ? prisma.userTopicPerformance.findMany({
              where: { userId: uid, topicId: { in: topicIds } },
            })
          : [],
        subtopicIds.length > 0
          ? prisma.userSubtopicPerformance.findMany({
              where: { userId: uid, subtopicId: { in: subtopicIds } },
            })
          : [],
        topicIds.length > 0
          ? prisma.userTopicDifficultyPerformance.findMany({
              where: { userId: uid, topicId: { in: topicIds } },
            })
          : [],
        prisma.userSubjectPerformance.findMany({
          where: { userId: uid, subjectId: { in: subjectIds } },
        }),
      ]);
    }

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
      if (!question) {
        console.warn(`Question ${answer.questionId} not found in database`);
        continue;
      }

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

        // Only process performance data if question has subtopic
        if (question.subtopic?.topicId) {
          const topicId = question.subtopic.topicId;
          const subtopicId = question.subtopic.id;
          const difficultyLevel = question.humanDifficultyLevel;
          const time = answer.timeTaken || 0;

          // Aggregate Topic Updates
          const topUpdate = topicUpdates.get(topicId) || {
            attempted: 0,
            correct: 0,
            time: 0,
          };
          topUpdate.attempted++;
          topUpdate.correct += isCorrect ? 1 : 0;
          topUpdate.time += time;
          topicUpdates.set(topicId, topUpdate);

          // Aggregate Subtopic Updates
          const subTopUpdate = subtopicUpdates.get(subtopicId) || {
            attempted: 0,
            correct: 0,
            time: 0,
          };
          subTopUpdate.attempted++;
          subTopUpdate.correct += isCorrect ? 1 : 0;
          subTopUpdate.time += time;
          subtopicUpdates.set(subtopicId, subTopUpdate);

          // Aggregate Difficulty Level Updates for the Topic
          if (difficultyLevel) {
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
        }
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

    console.log("Answer Processing Results:", {
      totalCorrect,
      totalIncorrect,
      totalAttempted,
      totalUnattempted,
      topicUpdatesCount: topicUpdates.size,
      subtopicUpdatesCount: subtopicUpdates.size,
      userTestAnswerPayloads: userTestAnswerPayloads.length,
    });

    // --- PHASE 4: DATABASE TRANSACTION ---
    const transactionPromises = [];

    // Promise 1: Create UserTestAnswer records
    if (userTestAnswerPayloads.length > 0) {
      transactionPromises.push(
        prisma.userTestAnswer.createMany({ data: userTestAnswerPayloads })
      );
      console.log("Added UserTestAnswer creation to transaction");
    }

    // Promise 2: Upsert UserTopicPerformance records
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
    console.log(
      `Added ${topicUpdates.size} topic performance updates to transaction`
    );

    // Promise 3: Upsert UserSubtopicPerformance records
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
    console.log(
      `Added ${subtopicUpdates.size} subtopic performance updates to transaction`
    );

    // Promise 4: Upsert UserTopicDifficultyPerformance records
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
    console.log(
      `Added ${topicDifficultyUpdates.size} difficulty performance updates to transaction`
    );

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
    console.log(
      `Added ${subjectUpdates.size} subject performance updates to transaction`
    );

    // Promise 5: Update the final test summary (THIS IS THE CRITICAL ONE)
    const { marksPerCorrect, negativeMarksPerIncorrect } = testInstance.exam;
    const finalScore =
      totalCorrect * marksPerCorrect -
      totalIncorrect * negativeMarksPerIncorrect;
    const testSummaryUpdate = prisma.userTestInstanceSummary.update({
      where: { id: testInstanceId },
      data: {
        score: finalScore,
        numCorrect: totalCorrect,
        numIncorrect: totalIncorrect,
        numUnattempted: totalUnattempted,
        timeTakenSec: Math.round(totalTimeTakenSec),
        completedAt: new Date(),
      },
    });
    transactionPromises.push(testSummaryUpdate);
    console.log("Added test instance summary update to transaction:", {
      testInstanceId,
      finalScore,
      totalCorrect,
      totalIncorrect,
      totalUnattempted,
      timeTakenSec: Math.round(totalTimeTakenSec),
    });

    console.log(`Total transaction promises: ${transactionPromises.length}`);

    // Execute all database writes in a single transaction
    try {
      console.log("Executing transaction...");
      const transactionResults = await prisma.$transaction(transactionPromises);
      console.log("Transaction completed successfully");
      console.log("Transaction results count:", transactionResults.length);
    } catch (transactionError) {
      console.error("Transaction failed:", transactionError);
      throw transactionError;
    }

    // Clean up Redis progress
    await redisClient.del(redisKey);
    console.log("Redis progress cleaned up");

    // --- PHASE 6: BACKGROUND AGGREGATE UPDATES (FIRE-AND-FORGET) ---
    setImmediate(() => {
      updateUserOverallAverage(uid).catch(console.error);
      if (topicIds.length > 0)
        updateGlobalTopicAverages(topicIds).catch(console.error);
      if (subtopicIds.length > 0)
        updateGlobalSubtopicAverages(subtopicIds).catch(console.error);
      // ADDED:
      if (subjectIds.length > 0) {
        // Assuming this utility function exists
        updateGlobalSubjectAverages(subjectIds).catch(console.error);
      }
      if (subjectIds.length > 0) {
        void updateDailyPerformanceAndStreak(uid, {
          totalAttempted: totalAttempted,
          totalCorrect: totalCorrect,
          timeTakenSec: Math.round(totalTimeTakenSec),
        });
      }
    });

    // --- PHASE 7: RESPOND TO USER ---
    const accuracyPercent =
      totalAttempted > 0 ? (totalCorrect / totalAttempted) * 100 : 0;

    const responseData = {
      success: true,
      data: {
        summary: {
          testInstanceId,
          score: finalScore,
          totalMarks: testInstance.totalMarks,
          accuracyPercentage: Number(accuracyPercent.toFixed(2)),
          totalCorrect,
          totalIncorrect,
          totalUnattempted,
          timeTakenSec: Math.round(totalTimeTakenSec),
        },
      },
    };

    console.log("Sending response:", responseData);
    res.status(200).json(responseData);
  } catch (error) {
    console.error("Error submitting PYQ test:", error);

    // Handle specific Prisma errors
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return res.status(404).json({
          success: false,
          error: "Test instance to update was not found.",
        });
      }
      if (error.code === "P2002") {
        return res.status(409).json({
          success: false,
          error:
            "Duplicate entry detected. Test may have already been submitted.",
        });
      }
    }

    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// ROUTE 5: GET /pyq/results/:testInstanceId
const getPyqTestResults = async (req: Request, res: Response) => {
  try {
    const { testInstanceId } = req.params;
    const { uid } = req.user;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!testInstanceId)
      return res.status(400).json({ error: "Test instance ID is required" });

    // Step 1: Fetch the core test instance data
    const testInstance = await prisma.userTestInstanceSummary.findUnique({
      where: { id: testInstanceId, userId: uid },
      include: {
        answers: {
          orderBy: { question: { id: "asc" } },
          include: {
            question: {
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

    // Step 2: Collect all unique IDs from the test results
    const topicIds = new Set<number>();
    const subtopicIds = new Set<number>();
    testInstance.answers.forEach((answer) => {
      if (answer.question?.subtopic?.topic?.id) {
        topicIds.add(answer.question.subtopic.topic.id);
      }
      if (answer.question?.subtopic?.id) {
        subtopicIds.add(answer.question.subtopic.id);
      }
    });

    const topicIdsArray = [...topicIds];
    const subtopicIdsArray = [...subtopicIds];

    // Step 3: Fetch ALL relevant performance data in parallel (This part is perfect)
    const [
      currentUser,
      topicAverages,
      subtopicAverages,
      userTopicPerformances,
      userSubtopicPerformances,
      userDifficultyPerformances,
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: uid },
        select: { overallAverageAccuracy: true },
      }),
      prisma.topic.findMany({
        where: { id: { in: topicIdsArray } },
        select: { id: true, averageAccuracyPercent: true },
      }),
      prisma.subtopic.findMany({
        where: { id: { in: subtopicIdsArray } },
        select: { id: true, averageAccuracyPercent: true },
      }),
      prisma.userTopicPerformance.findMany({
        where: { userId: uid, topicId: { in: topicIdsArray } },
      }),
      prisma.userSubtopicPerformance.findMany({
        where: { userId: uid, subtopicId: { in: subtopicIdsArray } },
      }),
      prisma.userTopicDifficultyPerformance.findMany({
        where: { userId: uid, topicId: { in: topicIdsArray } },
      }),
    ]);

    // Step 4: Create Maps for efficient lookups (This part is perfect)
    const topicAverageMap = new Map(
      topicAverages.map((t) => [t.id, t.averageAccuracyPercent])
    );
    const subtopicAverageMap = new Map(
      subtopicAverages.map((st) => [st.id, st.averageAccuracyPercent])
    );
    const userTopicPerfMap = new Map(
      userTopicPerformances.map((p) => [p.topicId, p])
    );
    const userSubtopicPerfMap = new Map(
      userSubtopicPerformances.map((p) => [p.subtopicId, p])
    );
    const userDifficultyPerfMap = new Map(
      userDifficultyPerformances.map((p) => [
        `${p.topicId}-${p.difficultyLevel}`,
        p,
      ])
    );

    // Step 5: Build the analysis object with the corrected initialization
    const initialValue: { [key: string]: any } = {};
    const subjectAnalysis = testInstance.answers.reduce((acc, answer) => {
      const { question } = answer;
      const subtopic = question?.subtopic;
      const topic = subtopic?.topic;
      const subject = topic?.subject;
      const difficulty = question?.humanDifficultyLevel;

      if (!question || !subtopic || !topic || !subject || !difficulty)
        return acc;

      const subjectName = subject.name;
      const topicName = topic.name;
      const subtopicName = subtopic.name;

      if (!acc[subjectName]) {
        acc[subjectName] = {
          totalQuestions: 0,
          correctAnswers: 0,
          totalTimeTakenSec: 0,
          topics: {},
        };
      }

      if (!acc[subjectName].topics[topicName]) {
        acc[subjectName].topics[topicName] = {
          totalQuestions: 0,
          correctAnswers: 0,
          totalTimeTakenSec: 0,
          communityAverageAccuracy: Number(
            topicAverageMap.get(topic.id) ?? 0
          ).toFixed(2),
          userOverallPerformance: userTopicPerfMap.get(topic.id) || null,
          subtopics: {},
          difficultyBreakdown: {},
        };
      }
      if (!acc[subjectName].topics[topicName].subtopics[subtopicName]) {
        acc[subjectName].topics[topicName].subtopics[subtopicName] = {
          totalQuestions: 0,
          correctAnswers: 0,
          totalTimeTakenSec: 0,
          communityAverageAccuracy: Number(
            subtopicAverageMap.get(subtopic.id) ?? 0
          ).toFixed(2),
          userOverallPerformance: userSubtopicPerfMap.get(subtopic.id) || null,
          questions: [],
        };
      }
      if (!acc[subjectName].topics[topicName].difficultyBreakdown[difficulty]) {
        acc[subjectName].topics[topicName].difficultyBreakdown[difficulty] = {
          totalQuestions: 0,
          correctAnswers: 0,
          totalTimeTakenSec: 0,
          userOverallPerformance:
            userDifficultyPerfMap.get(`${topic.id}-${difficulty}`) || null,
        };
      }

      // Now, the aggregation logic works correctly for all levels
      const subjectData = acc[subjectName];
      const topicData = subjectData.topics[topicName];
      const subtopicData = topicData.subtopics[subtopicName];
      const difficultyData = topicData.difficultyBreakdown[difficulty];

      subjectData.totalQuestions++;
      topicData.totalQuestions++;
      subtopicData.totalQuestions++;
      difficultyData.totalQuestions++;

      subjectData.totalTimeTakenSec += answer.timeTakenSec;
      topicData.totalTimeTakenSec += answer.timeTakenSec;
      subtopicData.totalTimeTakenSec += answer.timeTakenSec;
      difficultyData.totalTimeTakenSec += answer.timeTakenSec;

      if (answer.isCorrect) {
        subjectData.correctAnswers++;
        topicData.correctAnswers++;
        subtopicData.correctAnswers++;
        difficultyData.correctAnswers++;
      }

      subtopicData.questions.push({
        questionId: question.id,
        question: question.question,
        userAnswer: answer.userAnswer,
        correctOption: question.correctOption,
        options: question.options,
        imageUrl: question.imageUrl,
        imagesolurl: question.imagesolurl,
        solution: question.solution,
        isCorrect: answer.isCorrect,
        timeTakenSec: answer.timeTakenSec,
      });

      return acc;
    }, initialValue);

    // Step 6: Calculate final accuracy percentages for this test (This part is perfect)
    for (const subjectName in subjectAnalysis) {
      const subjectData = subjectAnalysis[subjectName];
      subjectData.accuracy = (
        subjectData.totalQuestions > 0
          ? (subjectData.correctAnswers / subjectData.totalQuestions) * 100
          : 0
      ).toFixed(2);
      subjectData.avgTimePerQuestionSec = (
        subjectData.totalQuestions > 0
          ? subjectData.totalTimeTakenSec / subjectData.totalQuestions
          : 0
      ).toFixed(2);
      for (const topicName in subjectData.topics) {
        const topicData = subjectData.topics[topicName];
        topicData.accuracy = (
          topicData.totalQuestions > 0
            ? (topicData.correctAnswers / topicData.totalQuestions) * 100
            : 0
        ).toFixed(2);
        topicData.avgTimePerQuestionSec = (
          topicData.totalQuestions > 0
            ? topicData.totalTimeTakenSec / topicData.totalQuestions
            : 0
        ).toFixed(2);
        for (const difficulty in topicData.difficultyBreakdown) {
          const diffData = topicData.difficultyBreakdown[difficulty];
          diffData.accuracy = (
            diffData.totalQuestions > 0
              ? (diffData.correctAnswers / diffData.totalQuestions) * 100
              : 0
          ).toFixed(2);
          diffData.avgTimePerQuestionSec = (
            diffData.totalQuestions > 0
              ? diffData.totalTimeTakenSec / diffData.totalQuestions
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
          subtopicData.avgTimePerQuestionSec = (
            subtopicData.totalQuestions > 0
              ? subtopicData.totalTimeTakenSec / subtopicData.totalQuestions
              : 0
          ).toFixed(2);
        }
      }
    }

    // Step 7: Send the final, enriched response (This part is perfect)
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
          userOverallAverageAccuracy: Number(
            currentUser?.overallAverageAccuracy ?? 0
          ).toFixed(2),
          timeTakenSec: testInstance.timeTakenSec,
          avgTimePerQuestionSec: (testInstance.totalQuestions > 0
            ? testInstance.timeTakenSec / testInstance.totalQuestions
            : 0
          ).toFixed(2),
        },
        subjectAnalysis: subjectAnalysis,
      },
    });
  } catch (error) {
    console.error("Error getting weakness test results:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// === EXPORTS ===
export {
  getAvailablePyqs,
  getLatestPyqResultId,
  generatePyqTest,
  submitPyqTest,
  getPyqBestScore,
  getPyqDataForTaking,
  getPyqTestResults,
  getPyqPercentile,
};
