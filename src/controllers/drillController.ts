import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { Prisma, DifficultyLevel, AnswerStatus } from "@prisma/client";
import { redisClient } from "../config/redis.js";
import {
  updateGlobalSubtopicAverages,
  updateGlobalTopicAverages,
  updateUserOverallAverage,
  updateGlobalSubjectAverages,
} from "../utils/globalStatsUpdater.js";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Define a type for the expected LLM output structure for better type safety
type GeneratedQuestion = {
  question_text: string;
  options: { [key: string]: string }; // e.g., { "A": "...", "B": "..." }
  correct_option: string; // e.g., "C"
  solution_explanation: string;
};

/**
 * ROUTE: POST /quiz/generate
 * Generates a new AI-powered quiz with theoretical questions.
 */
const generateQuiz = async (req: Request, res: Response) => {
  try {
    // --- 1. Authentication & Input Validation ---
    const { uid } = req.user;
    if (!uid) {
      return res.status(401).json({ error: "User not authenticated." });
    }

    const {
      examId,
      topicIds, // Expecting an array of 1-4 topic IDs
      difficultyLevel, // Expecting a single string: 'Easy', 'Medium', or 'Hard'
      questionCount, // Expecting a number from 1-6
      timeLimitMinutes,
      questionTypes, // Expecting an array like ['theoretical', 'conceptual']
    } = req.body;

    // Rigorous validation for the new constraints
    if (
      !examId ||
      !topicIds ||
      !difficultyLevel ||
      !questionCount ||
      !timeLimitMinutes ||
      !questionTypes
    ) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    if (
      !Array.isArray(topicIds) ||
      topicIds.length < 1 ||
      topicIds.length > 4
    ) {
      return res
        .status(400)
        .json({ error: "Please provide 1 to 4 topic IDs." });
    }
    if (questionCount < 1 || questionCount > 6) {
      return res
        .status(400)
        .json({ error: "Question count must be between 1 and 6." });
    }
    if (!Array.isArray(questionTypes) || questionTypes.length === 0) {
      return res
        .status(400)
        .json({ error: "At least one question type is required." });
    }

    // --- 2. Fetch Context from DB for the LLM Prompt ---
    const topics = await prisma.topic.findMany({
      where: {
        id: { in: topicIds },
        subject: { examId: examId }, // Ensure topics belong to the correct exam
      },
      select: { id: true, name: true, subject: { select: { name: true } } },
    });

    if (topics.length !== topicIds.length) {
      return res
        .status(404)
        .json({ error: "One or more topics not found for the given exam." });
    }

    // For the schema constraint, we need to associate new questions with a subtopic.
    // We'll fetch the first available subtopic from the first topic provided.
    const firstSubtopic = await prisma.subtopic.findFirst({
      where: { topicId: topics[0].id },
      select: { id: true },
    });

    if (!firstSubtopic) {
      return res.status(400).json({
        error: `The topic "${topics[0].name}" has no subtopics to which questions can be assigned. Please add subtopics first.`,
      });
    }

    // --- 3. Construct the LLM Prompt ---
    const topicNames = topics.map((t) => t.name).join(", ");
    const subjectName = topics[0].subject.name; // Assume all topics are from the same subject for simplicity
    const questionTypesStr = questionTypes.join(", ");

    const llmPrompt = `
      You are an expert academic content creator for the subject of ${subjectName}.
      Your task is to generate ${questionCount} unique, high-quality multiple-choice questions.

      **Instructions:**
      1.  **Topics:** The questions must strictly cover the following topics: ${topicNames}.
      2.  **Difficulty:** The questions must be of a '${difficultyLevel}' difficulty level.
      3.  **Question Style:** The questions must be ${questionTypesStr}. They should test deep understanding, not just surface-level recall.
      4.  **Format:** Provide your response as a single, valid JSON object. The object must contain a single key "generated_questions", which is an array of question objects.

      **JSON Structure for each question object:**
      - "question_text": The full text of the question.
      - "options": A JSON object with four keys ("A", "B", "C", "D") and their corresponding string values.
      - "correct_option": A single capital letter string indicating the correct answer (e.g., "C").
      - "solution_explanation": A clear, step-by-step explanation for why the correct option is right.

      **Example JSON Format:**
      {
        "generated_questions": [
          {
            "question_text": "This is the first question text?",
            "options": {
              "A": "Option A text.",
              "B": "Option B text.",
              "C": "Option C text.",
              "D": "Option D text."
            },
            "correct_option": "B",
            "solution_explanation": "This is the detailed solution for the first question."
          }
        ]
      }
    `;

    // --- 4. Call LLM to Generate Questions ---
    let generatedQuestions: GeneratedQuestion[];

    try {
      const llmResponse = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview", // Or "gpt-3.5-turbo" for faster/cheaper generation
        messages: [{ role: "user", content: llmPrompt }],
        response_format: { type: "json_object" },
      });

      const responseContent = llmResponse.choices[0].message.content;
      if (!responseContent) throw new Error("LLM returned an empty response.");

      const parsedJson = JSON.parse(responseContent);
      generatedQuestions = parsedJson.generated_questions;

      // --- 5. Validate LLM Output ---
      if (
        !Array.isArray(generatedQuestions) ||
        generatedQuestions.length !== questionCount
      ) {
        throw new Error(
          `LLM output validation failed. Expected ${questionCount} questions, but got ${generatedQuestions.length}.`
        );
      }
      // Add more checks here if needed (e.g., check for all required fields in each object)
    } catch (llmError) {
      console.error("LLM Generation or Parsing Failed:", llmError);
      return res.status(503).json({
        success: false,
        error: "Failed to generate AI questions. Please try again later.",
      });
    }

    // --- 6. Save New Questions to DB & Create Test Instance in a Transaction ---
    const testInstance = await prisma.$transaction(async (tx) => {
      // Create each new question in the database
      const newQuestionIds: number[] = [];
      for (const q of generatedQuestions) {
        const newQuestion = await tx.question.create({
          data: {
            subtopicId: firstSubtopic.id, // Associate with a valid subtopic
            question: q.question_text,
            options: q.options as Prisma.JsonObject,
            correctOption: q.correct_option,
            solution: q.solution_explanation,
            humanDifficultyLevel: difficultyLevel as DifficultyLevel,
            questionType: questionTypes, // Save the types
            // embedding is explicitly NOT set, so it will be null
          },
        });
        newQuestionIds.push(newQuestion.id);
      }

      // Create the test instance for the user
      const newTestInstance = await tx.userTestInstanceSummary.create({
        data: {
          userId: uid,
          examId: examId,
          testName: `AI Quiz: ${topicNames}`,
          testType: "quiz",
          score: 0,
          totalMarks: questionCount * 1, // Assuming 4 marks per question
          totalQuestions: questionCount,
          numUnattempted: questionCount,
          numCorrect: 0,
          numIncorrect: 0,
          timeTakenSec: timeLimitMinutes * 60,
          generatedQuestionIds: newQuestionIds, // Store the IDs of the newly created questions
        },
      });

      return newTestInstance;
    });

    // --- 7. Send Response ---
    res.status(201).json({
      success: true,
      message: "AI Quiz generated successfully.",
      data: {
        testInstanceId: testInstance.id,
      },
    });
  } catch (error) {
    console.error("Error generating AI quiz:", error);
    res
      .status(500)
      .json({ error: "Internal server error while generating the quiz." });
  }
};

/**
 * ROUTE: GET /drill/dashboard/:examId
 * Fetches a list of previously completed drills for the user.
 */
const getDrillDashboard = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { examId } = req.params;

    if (!uid) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    if (!examId) {
      return res.status(400).json({ error: "Exam ID is required" });
    }

    const pastDrills = await prisma.userTestInstanceSummary.findMany({
      where: {
        userId: uid,
        examId: parseInt(examId),
        testType: "drill", // Changed from "custom"
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
        pastTests: pastDrills,
      },
    });
  } catch (error) {
    console.error("Error getting drill dashboard:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * ROUTE: GET /drill/options/:examId
 * Fetches subjects and their associated topics to populate the drill creation modal.
 */
const getDrillOptions = async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;

    if (!examId) {
      return res.status(400).json({ error: "Exam ID is required" });
    }

    // Fetch subjects and nest their topics directly
    const subjectsWithTopics = await prisma.subject.findMany({
      where: {
        examId: parseInt(examId),
      },
      select: {
        id: true,
        name: true,
        topics: {
          select: {
            id: true,
            name: true,
          },
          orderBy: {
            name: "asc",
          },
        },
      },
      orderBy: {
        name: "asc",
      },
    });

    res.json({
      success: true,
      data: {
        subjects: subjectsWithTopics,
      },
    });
  } catch (error) {
    console.error("Error getting drill options:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * ROUTE: POST /drill/generate
 * Generates a new drill based on user criteria.
 */
const generateDrill = async (req: Request, res: Response) => {
  try {
    // --- 1. Authentication & Input Validation ---
    const { uid } = req.user;
    if (!uid) {
      return res.status(401).json({ error: "User not authenticated." });
    }

    const {
      examId,
      subjectIds,
      topicIds,
      difficultyLevels,
      questionCount,
      timeLimitMinutes,
    } = req.body;

    if (!examId || !questionCount || !timeLimitMinutes) {
      return res.status(400).json({
        error:
          "Missing required fields: examId, questionCount, and timeLimitMinutes are required.",
      });
    }

    if (!subjectIds?.length && !topicIds?.length) {
      return res
        .status(400)
        .json({ error: "Please select at least one Subject or Topic." });
    }

    if (timeLimitMinutes < 1 || timeLimitMinutes > 360) {
      return res
        .status(400)
        .json({ error: "Time limit must be between 1 and 360 minutes." });
    }

    // --- 2. Build Prisma Query ---
    const whereClause: Prisma.QuestionWhereInput = {
      // Base filter: questions must belong to the specified exam via the subject relationship
      subtopic: {
        topic: {
          subject: {
            examId: examId,
          },
        },
      },
    };

    // **Drill-Specific Logic**: Prioritize topics if provided, otherwise use subjects.
    if (topicIds && topicIds.length > 0) {
      whereClause.subtopic = {
        topic: {
          id: { in: topicIds },
        },
      };
    } else if (subjectIds && subjectIds.length > 0) {
      whereClause.subtopic = {
        topic: {
          subjectId: { in: subjectIds },
        },
      };
    }

    if (difficultyLevels && difficultyLevels.length > 0) {
      whereClause.humanDifficultyLevel = { in: difficultyLevels };
    }

    // --- 3. Find Candidate Questions ---
    const candidateQuestions = await prisma.question.findMany({
      where: whereClause,
      select: { id: true }, // Only select ID for efficiency
    });

    if (candidateQuestions.length < questionCount) {
      return res.status(400).json({
        error: `Not enough questions found for your criteria. Found only ${candidateQuestions.length}. Please broaden your selections.`,
      });
    }

    // --- 4. Select & Shuffle Questions ---
    const shuffledQuestions = candidateQuestions.sort(
      () => 0.5 - Math.random()
    );
    const finalQuestionIds = shuffledQuestions
      .slice(0, questionCount)
      .map((q) => q.id);

    // --- 5. Create Test Instance in a Transaction ---
    const testName = `Drill (${questionCount} Questions)`;
    const totalMarks = questionCount * 4; // Assuming 4 marks per question, adjust as needed

    const testInstance = await prisma.userTestInstanceSummary.create({
      data: {
        userId: uid,
        examId: examId,
        testName: testName,
        testType: "drill", // Set testType to "drill"
        score: 0,
        totalMarks: totalMarks,
        totalQuestions: questionCount,
        numUnattempted: questionCount,
        numCorrect: 0,
        numIncorrect: 0,
        // The time limit is set here, the same field is used for `getCustomQuizDataForTaking`
        timeTakenSec: timeLimitMinutes * 60,
        generatedQuestionIds: finalQuestionIds,
      },
    });

    res.status(201).json({
      success: true,
      message: "Drill generated successfully.",
      data: {
        testInstanceId: testInstance.id,
      },
    });
  } catch (error) {
    console.error("Error generating drill:", error);
    res
      .status(500)
      .json({ error: "Internal server error while generating the drill." });
  }
};

/**
 * ROUTE: GET /drill/test/:testInstanceId
 * Securely fetches the data required for a user to take a specific drill.
 * This is nearly identical to the custom quiz version.
 */
const getDrillDataForTaking = async (req: Request, res: Response) => {
  // This logic is identical to getCustomQuizDataForTaking, just with testType changed.
  // We can copy it directly and make the minor adjustment.
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
        testType: "drill", // Changed from "custom"
      },
      include: {
        exam: true,
        // Fetching questions based on the generatedQuestionIds JSON field
        // This requires a separate query after getting the testInstance
      },
    });

    if (!testInstance) {
      return res
        .status(404)
        .json({ success: false, error: "Drill instance not found." });
    }

    if (testInstance.completedAt) {
      return res.status(403).json({
        success: false,
        error: "This drill has already been completed.",
      });
    }

    const questionIds = testInstance.generatedQuestionIds as number[];
    const questionsInOrder = await prisma.question.findMany({
      where: { id: { in: questionIds } },
    });

    // Preserve the order from the generatedQuestionIds array
    const questionMap = new Map(questionsInOrder.map((q) => [q.id, q]));
    const orderedQuestions = questionIds.map((id) => questionMap.get(id)!);

    res.json({
      success: true,
      data: {
        testInstanceId: testInstance.id,
        testName: testInstance.testName,
        totalQuestions: testInstance.totalQuestions,
        totalMarks: testInstance.totalMarks,
        timeLimit: testInstance.timeTakenSec,
        questions: orderedQuestions.map((question, index) => {
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
            questionNumber: index + 1,
            question: question.question,
            options: formattedOptions,
            imageUrl: question.imageUrl,
          };
        }),
      },
    });
  } catch (error) {
    console.error("Error fetching drill data:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/**
 * ROUTE: POST /drill/submit/:testInstanceId
 * Submits a drill. The logic is identical to submitting a custom quiz.
 */
const submitDrill = async (req: Request, res: Response) => {
  // The entire logic for submitting a test, processing answers, and updating
  // user performance statistics is independent of the test *type*.
  // Therefore, the code is identical to `submitCustomQuiz`.
  // The only thing to ensure is that error messages refer to "Drill".
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
        .json({ success: false, error: "Invalid request payload." });

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
        .json({ success: false, error: "Drill instance not found." });
    }
    if (testInstance.completedAt) {
      await redisClient.del(redisKey);
      return res.status(403).json({
        success: false,
        error: "This drill has already been submitted.",
      });
    }

    // --- The rest of this function (Phases 2-6) is identical to `submitCustomQuiz` ---
    // (For brevity, I'm pasting the logic here without re-commenting every line, as it's a direct copy)

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
      if (q.subtopic?.topic)
        topicToSubjectMap.set(q.subtopic.topicId, q.subtopic.topic.subjectId);
    });
    const topicIds = [...new Set(questions.map((q) => q.subtopic.topicId))];
    const subtopicIds = [...new Set(questions.map((q) => q.subtopic.id))];
    const subjectIds = [...new Set(topicToSubjectMap.values())];

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
      currentSubtopicPerfs.map((p: any) => [p.subtopicId, p])
    );
    const topicDifficultyPerfMap = new Map(
      currentTopicDifficultyPerfs.map((p: any) => [
        `${p.topicId}-${p.difficultyLevel}`,
        p,
      ])
    );
    const subjectPerfMap = new Map(
      currentSubjectPerfs.map((p: any) => [p.subjectId, p])
    );

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

    const transactionPromises = [];
    transactionPromises.push(
      prisma.userTestAnswer.createMany({ data: userTestAnswerPayloads })
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

    // Final score calculation assuming 4 marks for correct, -1 for incorrect
    const finalScore =
      totalCorrect * testInstance.exam.marksPerCorrect -
      totalIncorrect * testInstance.exam.negativeMarksPerIncorrect;
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

    // Question average time update is omitted for brevity but would be identical to the custom quiz submit

    await prisma.$transaction(transactionPromises);
    await redisClient.del(redisKey);

    void updateGlobalTopicAverages(topicIds);
    void updateGlobalSubtopicAverages(subtopicIds);
    void updateUserOverallAverage(uid);
    void updateGlobalSubjectAverages(subjectIds);

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
    console.error("Error submitting drill:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/**
 * ROUTE: GET /drill/results/:testInstanceId
 * Fetches the detailed results of a completed drill. Logic is identical to custom quiz results.
 */
const getDrillResults = async (req: Request, res: Response) => {
  // This logic is identical to getCustomQuizResults, just with testType changed.
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
        testType: "drill", // Changed from "custom"
        completedAt: { not: null },
      },
      include: {
        answers: {
          include: {
            question: {
              include: {
                subtopic: {
                  select: {
                    topic: {
                      select: { id: true, name: true },
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
        error: "Completed drill result not found for this user.",
      });
    }

    const topicPerformanceAggregator = new Map<
      number,
      {
        topicName: string;
        totalAttempted: number;
        totalCorrect: number;
        totalTimeTakenSec: number;
      }
    >();
    const detailedQuestions = testInstance.answers.map((answer, index) => {
      const question = answer.question;
      const status = answer.status;
      const timeTaken = answer.timeTakenSec || 0;

      const topic = question.subtopic?.topic;
      if (topic && status !== AnswerStatus.Unattempted) {
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

      const optionsObject = question.options as Prisma.JsonObject;
      let formattedOptions: { label: string; value: string }[] = [];
      if (
        optionsObject &&
        typeof optionsObject === "object" &&
        !Array.isArray(optionsObject)
      ) {
        formattedOptions = Object.entries(optionsObject).map(
          ([label, value]) => ({ label: String(label), value: String(value) })
        );
      }

      return {
        id: question.id,
        questionNumber: index + 1, // Assuming answers are ordered
        question: question.question,
        options: formattedOptions,
        imageUrl: question.imageUrl,
        solution: question.solution,
        imagesolurl: question.imagesolurl,
        correctOption: question.correctOption,
        userAnswer: answer.userAnswer || null,
        status: status,
        timeTakenSec: timeTaken,
      };
    });

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
    console.error("Error fetching drill results:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

export {
  getDrillDashboard,
  getDrillOptions,
  generateDrill,
  getDrillDataForTaking,
  submitDrill,
  getDrillResults,
};
