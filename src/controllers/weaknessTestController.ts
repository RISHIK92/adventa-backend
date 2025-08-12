import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { AnswerStatus, type Question } from "@prisma/client";

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

    const weakestSubtopics = await prisma.userSubtopicPerformance.findMany({
      where: {
        userId: uid,
        totalAttempted: { gte: 3 }, // Only consider subtopics with at least 3 attempts
        subtopic: { topic: { subject: { examId: exam.id } } },
      },
      select: {
        accuracyPercent: true,
        subtopic: {
          select: {
            name: true,
            id: true,
            topic: {
              select: { name: true, subject: { select: { name: true } } },
            },
          },
        },
      },
      orderBy: { accuracyPercent: "asc" },
      take: 15, // Take a pool of the 15 weakest subtopics
    });

    if (weakestSubtopics.length < 3) {
      return res.status(400).json({
        error:
          "Not enough performance data to generate a weakness test. Please attempt more questions in this exam.",
      });
    }

    // Group by subjects and get top subtopics
    const subjectGroups: {
      [key: string]: {
        subtopicId: number;
        subtopicName: string;
        accuracy: number;
      }[];
    } = {};
    weakestSubtopics.forEach((p) => {
      const subjectName = p.subtopic.topic.subject.name;
      if (!subjectGroups[subjectName]) subjectGroups[subjectName] = [];
      if (subjectGroups[subjectName].length < 5) {
        // Limit to 5 per subject for the preview
        subjectGroups[subjectName].push({
          subtopicId: p.subtopic.id,
          subtopicName: p.subtopic.name,
          accuracy: Number(p.accuracyPercent),
        });
      }
    });

    const totalSubtopicsForTest = Object.values(subjectGroups).reduce(
      (sum, topics) => sum + topics.length,
      0
    );
    const expectedQuestions = totalSubtopicsForTest * 3; // Hardcoded rule: 3 questions per weak subtopic

    res.json({
      success: true,
      data: {
        examId: exam.id,
        examName: exam.name,
        expectedQuestions,
        estimatedTimeMinutes: Math.ceil((expectedQuestions * 120) / 60), // Use a default estimate
        subjectBreakdown: subjectGroups,
      },
    });
  } catch (error) {
    console.error("Error getting weakest topics preview:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ROUTE 3: POST /weakness/generate - Create the test instance and return questions
const generateWeaknessTest = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { examId } = req.body;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!examId) return res.status(400).json({ error: "Exam ID is required" });

    // 1. Fetch the Exam Blueprint
    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) return res.status(404).json({ error: "Exam not found" });

    // 2. Find the user's weakest subtopics for this exam
    const weakestSubtopicsPerformance =
      await prisma.userSubtopicPerformance.findMany({
        where: {
          userId: uid,
          totalAttempted: { gte: 3 },
          subtopic: { topic: { subject: { examId: exam.id } } },
        },
        orderBy: { accuracyPercent: "asc" },
        take: 15,
      });

    if (weakestSubtopicsPerformance.length < 3) {
      return res
        .status(400)
        .json({ error: "Not enough performance data to generate test." });
    }

    const weakSubtopicIds = weakestSubtopicsPerformance.map(
      (p) => p.subtopicId
    );

    // 3. PERFORMANCE FIX: Fetch all candidate questions at once
    const candidateQuestions = await prisma.question.findMany({
      where: { subtopicId: { in: weakSubtopicIds } },
    });

    // 4. Group candidates and select questions in-memory
    const questionsBySubtopic = new Map<number, Question[]>();
    candidateQuestions.forEach((q: any) => {
      if (!questionsBySubtopic.has(q.subtopicId))
        questionsBySubtopic.set(q.subtopicId, []);
      questionsBySubtopic.get(q.subtopicId)!.push(q);
    });

    let allQuestions: Question[] = [];
    for (const subtopicId of weakSubtopicIds) {
      const questionsForSubtopic = questionsBySubtopic.get(subtopicId) || [];
      const shuffled = questionsForSubtopic.sort(() => 0.5 - Math.random());
      allQuestions.push(...shuffled.slice(0, 3)); // Take 3 random questions per subtopic
    }

    if (allQuestions.length === 0) {
      return res
        .status(400)
        .json({ error: "Could not find any questions for your weak areas." });
    }

    // 5. Create the test instance using data from the Exam blueprint
    const testInstance = await prisma.userTestInstanceSummary.create({
      data: {
        userId: uid,
        examId: exam.id, // Storing the examId for context
        testName: `${exam.name} - Weakness Test`,
        testType: "weakness",
        score: 0,
        totalMarks: allQuestions.length * exam.marksPerCorrect, // DYNAMIC
        totalQuestions: allQuestions.length,
        numCorrect: 0,
        numIncorrect: 0,
        numUnattempted: allQuestions.length,
        timeTakenSec: 0,
      },
    });

    // 6. Prepare response for the frontend
    const avgTimePerQuestion =
      (exam.durationInMinutes * 60) / exam.totalQuestions;
    res.json({
      success: true,
      data: {
        testInstanceId: testInstance.id,
        testName: testInstance.testName,
        totalQuestions: allQuestions.length,
        totalMarks: testInstance.totalMarks,
        timeLimit: Math.round(allQuestions.length * avgTimePerQuestion), // DYNAMIC
        instructions: [
          `This test focuses on your weakest topics in ${exam.name}.`,
          `Each correct answer carries ${exam.marksPerCorrect} marks.`,
          `Each incorrect answer will result in a penalty of ${exam.negativeMarksPerIncorrect} mark(s).`,
          `Unattempted questions will receive ${exam.marksPerUnattempted} marks.`,
        ],
        questions: allQuestions.map((q, index) => ({
          id: q.id,
          questionNumber: index + 1,
          question: q.question,
          options: q.options,
          imageUrl: q.imageUrl,
        })),
      },
    });
  } catch (error) {
    console.error("Error generating weakness test:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ROUTE 4: POST /weakness/submit/:testInstanceId - Submit the completed test
const submitWeaknessTest = async (req: Request, res: Response) => {
  try {
    const { testInstanceId } = req.params;
    const { answers, timeTakenSec } = req.body as {
      answers: AnswerPayload[];
      timeTakenSec: number;
    };
    const { uid } = req.user;

    if (!uid) return res.status(401).json({ error: "User not authenticated" });
    if (!testInstanceId || !answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: "Invalid request payload." });
    }

    // --- PHASE 1: BULK READ ---
    const testInstance = await prisma.userTestInstanceSummary.findUnique({
      where: { id: testInstanceId, userId: uid },
      include: { exam: true },
    });

    if (!testInstance || !testInstance.exam) {
      return res
        .status(404)
        .json({ error: "Test instance or associated exam not found." });
    }

    const examBlueprint = testInstance.exam;
    const questionIds = answers.map((a) => a.questionId);

    const questions = await prisma.question.findMany({
      where: { id: { in: questionIds } },
    });
    const questionsMap = new Map<number, Question>(
      questions.map((q) => [q.id, q])
    );

    const subtopicIds = Array.from(new Set(questions.map((q) => q.subtopicId)));
    const currentPerformances = await prisma.userSubtopicPerformance.findMany({
      where: { userId: testInstance.userId, subtopicId: { in: subtopicIds } },
    });
    const performanceMap = new Map(
      currentPerformances.map((p) => [p.subtopicId, p])
    );

    // --- PHASE 2: IN-MEMORY PROCESSING ---
    let totalCorrect = 0,
      totalIncorrect = 0;
    const userTestAnswerPayloads: any[] = [];
    const subtopicUpdates = new Map<
      number,
      { attempted: number; correct: number; time: number }
    >();

    for (const answer of answers) {
      const question = questionsMap.get(answer.questionId);
      if (!question) continue;

      let isCorrect = false;
      let status: AnswerStatus = AnswerStatus.Unattempted;

      if (answer.userAnswer && answer.userAnswer.trim() !== "") {
        isCorrect =
          answer.userAnswer.trim().toUpperCase() ===
          question.correctOption.trim().toUpperCase();
        status = isCorrect ? AnswerStatus.Correct : AnswerStatus.Incorrect;
        if (isCorrect) totalCorrect++;
        else totalIncorrect++;

        const update = subtopicUpdates.get(question.subtopicId) || {
          attempted: 0,
          correct: 0,
          time: 0,
        };
        update.attempted++;
        update.correct += isCorrect ? 1 : 0;
        update.time += answer.timeTaken || 0;
        subtopicUpdates.set(question.subtopicId, update);
      }

      userTestAnswerPayloads.push({
        testInstanceId: testInstanceId,
        questionId: question.id,
        userId: testInstance.userId,
        userAnswer: answer.userAnswer || null,
        isCorrect: isCorrect,
        status: status,
        timeTakenSec: answer.timeTaken || 0,
      });
    }

    const totalAttempted = totalCorrect + totalIncorrect;
    const totalUnattempted = testInstance.totalQuestions - totalAttempted;

    // --- PHASE 3: BULK WRITE in a TRANSACTION ---
    const transactionPromises: any[] = [];

    transactionPromises.push(
      prisma.userTestAnswer.createMany({ data: userTestAnswerPayloads })
    );

    for (const [subtopicId, update] of subtopicUpdates.entries()) {
      const currentPerf = performanceMap.get(subtopicId);
      const newTotalAttempted =
        (currentPerf?.totalAttempted || 0) + update.attempted;
      const newTotalCorrect = (currentPerf?.totalCorrect || 0) + update.correct;
      const newTotalTimeTaken =
        (currentPerf?.totalTimeTakenSec || 0) + update.time;

      const upsertPromise = prisma.userSubtopicPerformance.upsert({
        where: {
          userId_subtopicId: { userId: testInstance.userId, subtopicId },
        },
        create: {
          userId: testInstance.userId,
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
          accuracyPercent: (newTotalCorrect / newTotalAttempted) * 100,
          avgTimePerQuestionSec: newTotalTimeTaken / newTotalAttempted,
        },
      });
      transactionPromises.push(upsertPromise);
    }

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

    await prisma.$transaction(transactionPromises);

    // --- FINAL RESPONSE ---
    const accuracyPercent =
      totalAttempted > 0 ? (totalCorrect / totalAttempted) * 100 : 0;
    res.status(200).json({
      success: true,
      data: {
        testInstanceId,
        score: finalScore,
        totalMarks: testInstance.totalMarks,
        accuracyPercentage: accuracyPercent.toFixed(2),
        totalCorrect,
        totalIncorrect,
        totalUnattempted,
      },
    });
  } catch (error) {
    console.error("Error submitting weakness test:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ROUTE 5: GET /weakness/results/:testInstanceId - Get detailed test results
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
          orderBy: { question: { id: "asc" } }, // Consistent ordering
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
        },
      },
    });

    if (!testInstance)
      return res.status(404).json({ error: "Test instance not found" });

    const subjectAnalysis = testInstance.answers.reduce((acc, answer) => {
      const subject = answer.question.subtopic.topic.subject.name;
      const subtopic = answer.question.subtopic.name;

      if (!acc[subject]) {
        acc[subject] = { totalQuestions: 0, correctAnswers: 0, subtopics: {} };
      }
      if (!acc[subject].subtopics[subtopic]) {
        acc[subject].subtopics[subtopic] = {
          totalQuestions: 0,
          correctAnswers: 0,
          questions: [],
        };
      }

      acc[subject].totalQuestions++;
      acc[subject].subtopics[subtopic].totalQuestions++;
      if (answer.isCorrect) {
        acc[subject].correctAnswers++;
        acc[subject].subtopics[subtopic].correctAnswers++;
      }

      acc[subject].subtopics[subtopic].questions.push({
        questionId: answer.question.id,
        question: answer.question.question,
        userAnswer: answer.userAnswer,
        correctOption: answer.question.correctOption,
        solution: answer.question.solution,
        isCorrect: answer.isCorrect,
        timeTakenSec: answer.timeTakenSec,
      });

      return acc;
    }, {} as any);

    // Calculate accuracy percentages
    for (const subjectName in subjectAnalysis) {
      const subjectData = subjectAnalysis[subjectName];
      subjectData.accuracy = (
        (subjectData.correctAnswers / subjectData.totalQuestions) *
        100
      ).toFixed(2);
      for (const subtopicName in subjectData.subtopics) {
        const subtopicData = subjectData.subtopics[subtopicName];
        subtopicData.accuracy = (
          (subtopicData.correctAnswers / subtopicData.totalQuestions) *
          100
        ).toFixed(2);
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

export {
  getAvailableExams,
  getWeakestTopics,
  generateWeaknessTest,
  submitWeaknessTest,
  getWeaknessTestResults,
};
