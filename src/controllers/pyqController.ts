// /controllers/pyqController.ts

import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { AnswerStatus, Prisma } from "@prisma/client";

import { submitWeaknessTest as submitPyqTest } from "./weaknessTestController.js";
import { getWeaknessTestResults as getPyqTestResults } from "./weaknessTestController.js";
import { getTestDataForTaking as getPyqDataForTaking } from "./weaknessTestController.js";

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
          testName: `${examSession.exam.name} - ${examSession.name}`,
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
// This uses the exact same logic as getTestDataForTaking
// It already provides all the necessary details.

// ROUTE 4: POST /pyq/submit/:testInstanceId
// This uses the exact same logic as submitWeaknessTest.
// We just alias the import for clarity.

// ROUTE 5: GET /pyq/results/:testInstanceId
// This uses the exact same logic as getWeaknessTestResults.
// It already provides all the necessary details.

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
