import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { DifficultyLevel, Prisma } from "@prisma/client";

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
const embeddingModel = genAI.getGenerativeModel({
  model: "text-embedding-004",
});

type ExamDetails = {
  totalQuestions: number;
  marksPerCorrect: number;
  negativeMarksPerIncorrect: number;
};

async function createEmbedding(text: string): Promise<number[]> {
  if (!text) return [];
  try {
    const result = await embeddingModel.embedContent(text);
    return result.embedding.values || [];
  } catch (error) {
    console.error("Error creating embedding:", error);
    return [];
  }
}

async function semanticSearchByText(
  text: string,
  examId: number,
  take: number
): Promise<number[]> {
  const vector = await createEmbedding(text);
  if (vector.length === 0) return [];

  // pgvector expects a string representation of the vector: '[1,2,3,...]'
  const vectorSql = `[${vector.join(",")}]`;

  const results = await prisma.$queryRaw<{ id: number }[]>`
    SELECT q.id
    FROM "Question" q
    JOIN "Subtopic" st ON q."subtopicId" = st.id
    JOIN "Topic" t ON st."topicId" = t.id
    JOIN "Subject" s ON t."subjectId" = s.id
    WHERE s."examId" = ${examId} AND q.embedding IS NOT NULL
    ORDER BY q.embedding <-> ${vectorSql}::vector
    LIMIT ${take};
  `;
  return results.map((r) => r.id);
}

async function semanticSearchByVector(
  vector: number[],
  examId: number,
  take: number
): Promise<number[]> {
  if (vector.length === 0) return [];
  const vectorSql = `[${vector.join(",")}]`;

  const results = await prisma.$queryRaw<{ id: number }[]>`
    SELECT q.id
    FROM "Question" q
    JOIN "Subtopic" st ON q."subtopicId" = st.id
    JOIN "Topic" t ON st."topicId" = t.id
    JOIN "Subject" s ON t."subjectId" = s.id
    WHERE s."examId" = ${examId} AND q.embedding IS NOT NULL
    ORDER BY q.embedding <-> ${vectorSql}::vector
    LIMIT ${take};
  `;
  return results.map((r) => r.id);
}

function averageEmbeddings(embeddings: number[][]): number[] {
  if (!embeddings || embeddings.length === 0) return [];
  const vectorLength = embeddings[0]?.length || 0;
  if (vectorLength === 0) return [];

  const centroid = new Array(vectorLength).fill(0);
  for (const embedding of embeddings) {
    // Ensure all embeddings have the same dimension
    if (embedding.length === vectorLength) {
      for (let i = 0; i < vectorLength; i++) {
        centroid[i] += embedding[i];
      }
    }
  }
  return centroid.map((v) => v / embeddings.length);
}

/**
 * Generates a standard, weightage-based diagnostic test for new users or as a fallback.
 */
async function generateDiagnosticTest(
  examDetails: ExamDetails,
  examId: number,
  userId: string
) {
  console.log(`Generating a Diagnostic Test for user ${userId}`);
  const topics = await prisma.topic.findMany({
    where: { subject: { examId } },
    select: { id: true, examWeightage: true },
  });

  const questionsPerTopic: { topicId: number; count: number }[] = topics.map(
    (topic) => ({
      topicId: topic.id,
      count: Math.round(
        examDetails.totalQuestions *
          ((topic.examWeightage
            ? parseFloat(topic.examWeightage.toString())
            : 0) /
            100)
      ),
    })
  );

  const questionPromises = questionsPerTopic.map(({ topicId, count }) =>
    prisma.question.findMany({
      where: { subtopic: { topicId } },
      take: count > 0 ? count : 1, // Ensure at least one question is fetched if weightage is very low
      select: { id: true },
    })
  );

  const questionBatches = await Promise.all(questionPromises);
  let finalQuestionIds = questionBatches.flat().map((q) => q.id);
  // Ensure the final count matches the exam's total questions
  finalQuestionIds = finalQuestionIds.slice(0, examDetails.totalQuestions);

  return prisma.userTestInstanceSummary.create({
    data: {
      userId,
      examId,
      testName: `Diagnostic Test - ${new Date().toLocaleDateString()}`,
      testType: "diagnostic",
      totalQuestions: examDetails.totalQuestions,
      totalMarks: examDetails.totalQuestions * examDetails.marksPerCorrect, // DYNAMIC
      generatedQuestionIds: finalQuestionIds,
      score: 0,
      numCorrect: 0,
      numIncorrect: 0,
      numUnattempted: examDetails.totalQuestions,
      timeTakenSec: 0,
    },
  });
}

// --- Main Controller ---

export const createSmartMockTest = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { examId } = req.params;

    if (!examId) {
      return res
        .status(400)
        .json({ success: false, error: "Exam ID is required." });
    }

    const MIN_TESTS_FOR_SMART_MOCK = 3;
    const numericExamId = parseInt(examId, 10);

    if (isNaN(numericExamId)) {
      return res.status(400).json({
        success: false,
        error: "A valid numeric Exam ID is required.",
      });
    }

    // --- PHASE 1: COMPREHENSIVE USER ANALYSIS ---

    const [userSummary, examDetails] = await Promise.all([
      prisma.userExamOverallSummary.findUnique({
        where: { userId_examId: { userId: uid, examId: numericExamId } },
      }),
      prisma.exam.findUnique({
        where: { id: numericExamId },
        select: {
          totalQuestions: true,
          marksPerCorrect: true,
          negativeMarksPerIncorrect: true,
        },
      }),
    ]);

    if (!examDetails) {
      return res.status(404).json({
        success: false,
        error: `Exam with ID ${numericExamId} not found.`,
      });
    }

    if (
      !userSummary ||
      userSummary.totalMockTestsCompleted < MIN_TESTS_FOR_SMART_MOCK
    ) {
      const diagnosticTest = await generateDiagnosticTest(
        examDetails,
        numericExamId,
        uid
      );
      const testsNeeded =
        MIN_TESTS_FOR_SMART_MOCK - (userSummary?.totalMockTestsCompleted || 0);
      return res.status(202).json({
        success: true,
        mode: "DIAGNOSTIC",
        message: `Take ${testsNeeded} more general mock test(s) to unlock your personalized Smart Mock Test! We've generated a Diagnostic Test to get you started.`,
        data: { testInstanceId: diagnosticTest.id },
      });
    }

    const [
      mistakeAnswers,
      subtopicPerformances,
      topicPerformances,
      topicsWithWeightage,
      difficultyPerformances,
    ] = await Promise.all([
      prisma.userTestAnswer.findMany({
        where: {
          userId: uid,
          isCorrect: false,
          question: {
            subtopic: { topic: { subject: { examId: numericExamId } } },
          },
        },
        take: 30,
        orderBy: { testInstance: { completedAt: "desc" } },
        select: { questionId: true },
      }),
      prisma.userSubtopicPerformance.findMany({
        where: {
          userId: uid,
          subtopic: { topic: { subject: { examId: numericExamId } } },
        },
        include: { subtopic: true },
      }),
      prisma.userTopicPerformance.findMany({
        where: { userId: uid, topic: { subject: { examId: numericExamId } } },
      }),
      prisma.topic.findMany({
        where: { subject: { examId: numericExamId } },
        select: { id: true, name: true, examWeightage: true },
      }),
      prisma.userTopicDifficultyPerformance.findMany({
        where: {
          userId: uid,
          topicPerformance: { topic: { subject: { examId: numericExamId } } },
        },
      }),
    ]);

    let mistakeEmbeddings: number[][] = [];
    const mistakeQuestionIds = mistakeAnswers.map((ans) => ans.questionId);
    if (mistakeQuestionIds.length > 0) {
      type EmbeddingResult = { embedding: number[] };
      const results = await prisma.$queryRaw<EmbeddingResult[]>`
        SELECT embedding FROM "Question" WHERE id IN (${Prisma.join(
          mistakeQuestionIds
        )}) AND embedding IS NOT NULL
      `;
      mistakeEmbeddings = results.map((r) => r.embedding);
    }

    // Correctly calculate weak/strong/lagging topics
    const sortedByWeakness = [...subtopicPerformances].sort((a, b) =>
      a.accuracyPercent.comparedTo(b.accuracyPercent)
    );
    const top5Weak = sortedByWeakness.slice(0, 5);
    const weakSubtopicsForProfile = top5Weak.map((p) => ({
      name: p.subtopic.name,
      accuracy: p.accuracyPercent,
    }));

    const sortedByStrength = [...topicPerformances].sort((a, b) =>
      b.accuracyPercent.comparedTo(a.accuracyPercent)
    );
    const top5Strong = sortedByStrength.slice(0, 5);
    const strongTopicIdsForPool = top5Strong.map((p) => p.topicId);

    const totalQuestionsPracticedByUser = topicPerformances.reduce(
      (sum, p) => sum + p.totalAttempted,
      0
    );
    const laggingTopicIds: number[] = [];
    if (totalQuestionsPracticedByUser > 0) {
      const userPracticeDistribution = new Map(
        topicPerformances.map((p) => [p.topicId, p.totalAttempted])
      );
      topicsWithWeightage.forEach((topic) => {
        const examShare = parseFloat(topic.examWeightage as any);
        const userPracticeShare =
          ((userPracticeDistribution.get(topic.id) || 0) /
            totalQuestionsPracticedByUser) *
          100;
        if (userPracticeShare < examShare / 2 && examShare > 2) {
          laggingTopicIds.push(topic.id);
        }
      });
    }

    const topicsSortedByWeightage = [...topicsWithWeightage].sort((a, b) => {
      if (!a.examWeightage) return 1
      if (!b.examWeightage) return -1;
      return b.examWeightage.comparedTo(a.examWeightage);
    });
    const difficultyMap = new Map(
      difficultyPerformances.map((p) => [
        `${p.topicId}-${p.difficultyLevel}`,
        p,
      ])
    );
    const strategicWeaknesses: {
      topic: string;
      exam_weightage: string;
      struggling_at_difficulty: string;
      accuracy_at_that_level: string;
    }[] = [];

    // Calculate strategic weaknesses
    for (const topic of topicsSortedByWeightage) {
      const examWeightage = parseFloat(topic.examWeightage as any);
      if (examWeightage > 5) {
        // Only consider high-weightage topics
        for (const difficulty of [
          "Easy",
          "Medium",
          "Hard",
          "Elite",
        ] as DifficultyLevel[]) {
          const key = `${topic.id}-${difficulty}`;
          const performance = difficultyMap.get(key);
          if (performance && performance.accuracyPercent.lessThan(60)) {
            strategicWeaknesses.push({
              topic: topic.name,
              exam_weightage: `${examWeightage}%`,
              struggling_at_difficulty: difficulty,
              accuracy_at_that_level: `${performance.accuracyPercent}%`,
            });
            break; // Only add the first (easiest) struggling difficulty
          }
        }
      }
    }

    const top5StrategicWeaknesses = strategicWeaknesses.slice(0, 5);
    const weakTopicIdsForPool = topicsWithWeightage
      .filter((t) => top5StrategicWeaknesses.some((w) => w.topic === t.name))
      .map((t) => t.id);

    const userReadinessProfile = {
      overall_proficiency: userSummary.overallAccuracyPercent.greaterThan(75)
        ? "Advanced"
        : "Intermediate",
      strategic_weaknesses: top5StrategicWeaknesses,
      strong_topics: top5Strong.map(
        (p) =>
          topicsWithWeightage.find((tw) => tw.id === p.topicId)?.name ||
          "Unknown Topic"
      ),
      lagging_topics: topicsWithWeightage
        .filter((t) => laggingTopicIds.includes(t.id))
        .map((t) => t.name),
      mistake_history_summary: `Recent errors are conceptually similar to their weakest areas.`,
    };

    // --- PHASE 2: MULTI-SOURCE CANDIDATE POOLING ---
    const avgMistakeVector = averageEmbeddings(mistakeEmbeddings);
    const [
      weaknessPool,
      mistakeReinforcementPool,
      weightageCoveragePool,
      challengerPool,
      confidenceBoosterPool,
    ] = await Promise.all([
      semanticSearchByText(
        `User is weak in topics like ${weakSubtopicsForProfile
          .map((s) => s.name)
          .join(", ")}`,
        numericExamId,
        100
      ),
      avgMistakeVector.length > 0
        ? semanticSearchByVector(avgMistakeVector, numericExamId, 100)
        : Promise.resolve([]),
      laggingTopicIds.length > 0
        ? prisma.question.findMany({
            where: { subtopic: { topicId: { in: laggingTopicIds } } },
            take: 100,
            select: { id: true },
          })
        : Promise.resolve([]),
      prisma.question.findMany({
        where: {
          subtopic: { topic: { subject: { examId: numericExamId } } },
          humanDifficultyLevel: "Elite",
        },
        take: 30,
        select: { id: true },
      }),
      strongTopicIdsForPool.length > 0
        ? prisma.question.findMany({
            where: {
              subtopic: { topicId: { in: strongTopicIdsForPool } },
              humanDifficultyLevel: { in: ["Easy", "Medium"] },
            },
            take: 50,
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);

    // --- PHASE 3: LLM-DRIVEN STRATEGIC CURATION ---
    const allCandidateIds = [
      ...new Set([
        ...weaknessPool,
        ...mistakeReinforcementPool,
        ...weightageCoveragePool.map((q) => q.id),
        ...challengerPool.map((q) => q.id),
        ...confidenceBoosterPool.map((q) => q.id),
      ]),
    ];
    const candidateQuestionsMetadata = await prisma.question.findMany({
      where: { id: { in: allCandidateIds } },
      select: {
        id: true,
        humanDifficultyLevel: true,
        subtopic: {
          select: {
            topic: {
              select: { name: true, subject: { select: { name: true } } },
            },
          },
        },
      },
    });

    const llmPrompt = {
      task: "You are an expert test creator for exam preparation. Your goal is to select exactly the right questions for a personalized Smart Mock Test.",
      user_profile: userReadinessProfile,
      target_test_length: examDetails.totalQuestions,
      available_questions: candidateQuestionsMetadata.map((q) => ({
        id: q.id,
        topic: q.subtopic.topic.name,
        subject: q.subtopic.topic.subject.name,
        difficulty: q.humanDifficultyLevel,
      })),
      selection_strategy: {
        primary_focus: "Address strategic weaknesses first (60% of questions)",
        secondary_focus: "Include coverage questions for lagging topics (25%)",
        tertiary_focus: "Add confidence boosters and challenges (15%)",
      },
      output_format: {
        selected_question_ids:
          "Array of exactly " + examDetails.totalQuestions + " question IDs",
      },
      instructions: [
        "Select exactly " + examDetails.totalQuestions + " questions",
        "Prioritize questions that target the user's strategic weaknesses",
        "Ensure a mix of difficulties appropriate for the user's level",
        "Include questions from lagging topics to ensure coverage",
        "Add some confidence boosters from strong areas",
        "Return only a JSON object with 'selected_question_ids' array",
      ],
    };

    let finalQuestionIds: number[] = [];
    try {
      const result = await model.generateContent(
        `You are an expert test creator. Based on the following data, select exactly ${
          examDetails.totalQuestions
        } question IDs for a personalized Smart Mock Test.

User Profile: ${JSON.stringify(userReadinessProfile, null, 2)}

Available Questions: ${JSON.stringify(
          candidateQuestionsMetadata.map((q) => ({
            id: q.id,
            topic: q.subtopic.topic.name,
            difficulty: q.humanDifficultyLevel,
          })),
          null,
          2
        )}

Selection Strategy:
- 60% questions targeting strategic weaknesses
- 25% coverage questions for lagging topics  
- 15% confidence boosters and challenges

Return only a JSON object with this format:
{
  "selected_question_ids": [array of exactly ${
    examDetails.totalQuestions
  } question IDs]
}

Please respond with only the JSON object, no additional text.`
      );

      const responseContent = result.response.text();
      if (!responseContent)
        throw new Error("Gemini returned an empty response.");

      // Clean the response to ensure it's valid JSON
      const cleanedResponse = responseContent
        .trim()
        .replace(/```json|```/g, "");
      const parsedResponse = JSON.parse(cleanedResponse);
      finalQuestionIds = parsedResponse.selected_question_ids;

      if (
        !Array.isArray(finalQuestionIds) ||
        finalQuestionIds.length !== examDetails.totalQuestions
      ) {
        throw new Error(
          `LLM output validation failed. Expected ${examDetails.totalQuestions}, but got ${finalQuestionIds.length}.`
        );
      }
    } catch (llmError) {
      console.error("LLM Curation Failed:", llmError);
      const fallbackTest = await generateDiagnosticTest(
        examDetails,
        numericExamId,
        uid
      );
      return res.status(202).json({
        success: true,
        mode: "FALLBACK",
        message:
          "We encountered an issue creating your personalized test. Here is a general diagnostic test instead.",
        data: { testInstanceId: fallbackTest.id },
      });
    }

    // --- PHASE 4: TEST DELIVERY ---
    const newTestInstance = await prisma.userTestInstanceSummary.create({
      data: {
        userId: uid,
        examId: numericExamId,
        testName: `Smart Mock Test - ${new Date().toLocaleDateString()}`,
        testType: "mock",
        totalQuestions: examDetails.totalQuestions,
        totalMarks: examDetails.totalQuestions * examDetails.marksPerCorrect,
        generatedQuestionIds: finalQuestionIds,
        score: 0,
        numCorrect: 0,
        numIncorrect: 0,
        numUnattempted: examDetails.totalQuestions,
        timeTakenSec: 0,
      },
    });

    res.status(201).json({
      success: true,
      mode: "SMART_MOCK",
      message: "Your Smart Mock Test has been generated!",
      data: { testInstanceId: newTestInstance.id },
    });
  } catch (error) {
    console.error("Error creating Smart Mock Test:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};
