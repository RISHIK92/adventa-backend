import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import z from "zod";
import { DifficultyLevel } from "@prisma/client";
import { redisClient } from "../config/redis.js";

// Zod schema for validating the challenge creation payload
const createChallengeSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters long."),
  challengeType: z.enum(["topic", "subject"]),
  typeId: z.number().int().positive(), // This will be either topicId or subjectId
  difficulty: z.nativeEnum(DifficultyLevel),
  timeLimit: z.number().int().min(5, "Time limit must be at least 5 minutes."),
  questionCount: z.union([
    z.literal(1),
    z.literal(3),
    z.literal(6),
    z.literal(9),
    z.literal(12),
    z.literal(15),
  ]),
});

const submitPredictionSchema = z.object({
  predictedScore: z
    .number()
    .int()
    .min(0, "Predicted score cannot be negative."),
  confidence: z
    .number()
    .int()
    .min(0, "Confidence must be at least 0.")
    .max(100, "Confidence cannot exceed 100."),
});

interface RedisAnswerValue {
  answer: string | null;
  markedForReview: boolean;
}

/**
 * ROUTE: GET /api/study-group/:studyRoomId/challenge-options
 * Fetches all subjects and their associated topics for the "Create Challenge" form.
 */
const getChallengeOptions = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res
        .status(400)
        .json({ success: false, error: "Study room ID is required." });
    }

    // 1. Authorization: Verify the user is a member of the group
    const membership = await prisma.studyRoomMember.findUnique({
      where: { studyRoomId_userId: { studyRoomId, userId: uid } },
      include: { studyRoom: { select: { examId: true } } },
    });

    if (!membership || !membership.studyRoom.examId) {
      return res.status(403).json({
        success: false,
        error:
          "You are not a member of this group or the group has no associated exam.",
      });
    }

    const { examId } = membership.studyRoom;

    // 2. Fetch all subjects and their nested topics for the group's exam
    const subjectsWithTopics = await prisma.subject.findMany({
      where: { examId: examId },
      select: {
        id: true,
        name: true,
        topics: {
          select: {
            id: true,
            name: true,
          },
          orderBy: { name: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });

    res.json({ success: true, data: subjectsWithTopics });
  } catch (error) {
    console.error("Error fetching challenge options:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: POST /api/study-group/:studyRoomId/challenges
 * Creates a new challenge with complex, rule-based question generation.
 */
const createChallenge = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res
        .status(400)
        .json({ success: false, error: "Study room ID is required." });
    }

    const validation = createChallengeSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        errors: validation.error.flatten().fieldErrors,
      });
    }
    const {
      title,
      challengeType,
      typeId,
      difficulty,
      timeLimit,
      questionCount,
    } = validation.data;

    const membership = await prisma.studyRoomMember.findUnique({
      where: { studyRoomId_userId: { studyRoomId, userId: uid } },
    });
    if (!membership) {
      return res.status(403).json({
        success: false,
        error: "You must be a member of the group to create a challenge.",
      });
    }

    let finalQuestionIds: number[] = [];
    let topicIdForChallenge: number;

    if (challengeType === "topic") {
      // --- TOPIC-BASED CHALLENGE ---
      topicIdForChallenge = typeId;
      const questions = await prisma.$queryRaw<{ id: number }[]>`SELECT "id"
      FROM "Question"
      WHERE "humanDifficultyLevel" = ${difficulty}
        AND "subtopicId" IN (
          SELECT "id" FROM "Subtopic" WHERE "topicId" = ${topicIdForChallenge}
        )
      ORDER BY RANDOM()
      LIMIT ${questionCount};`;

      if (questions.length < questionCount) {
        return res.status(400).json({
          success: false,
          error: `Not enough '${difficulty}' questions found for this topic. Only found ${questions.length}.`,
        });
      }
      finalQuestionIds = questions.map((q) => q.id);
    } else {
      // --- SUBJECT-BASED CHALLENGE ---
      const allTopicsInSubject = await prisma.topic.findMany({
        where: { subjectId: typeId },
        select: { id: true },
      });

      if (allTopicsInSubject.length < 3) {
        return res.status(400).json({
          success: false,
          error:
            "This subject must have at least 3 topics to generate a challenge.",
        });
      }

      function shuffleArray<T>(array: T[]): T[] {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          if (i === j) continue;
          [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
        }
        return arr;
      }

      // 1. Randomly select 3 to 5 topics
      const shuffledTopics = shuffleArray(allTopicsInSubject);
      const topicsToQueryCount = Math.min(
        shuffledTopics.length,
        Math.floor(Math.random() * 3) + 3
      ); // 3, 4, or 5
      const selectedTopics = shuffledTopics.slice(0, topicsToQueryCount);
      if (!selectedTopics[0]) {
        return res.status(400).json({
          success: false,
          error: "Failed to select topics for the challenge. Please try again.",
        });
      }
      topicIdForChallenge = selectedTopics[0].id; // Assign the first topic for the relation

      // 2. Distribute question count among selected topics
      const questionsPerTopic = new Map<number, number>();
      const baseCount = Math.floor(questionCount / selectedTopics.length);
      let remainder = questionCount % selectedTopics.length;

      selectedTopics.forEach((topic) =>
        questionsPerTopic.set(topic.id, baseCount)
      );
      for (let i = 0; i < remainder; i++) {
        //@ts-ignore
        const topicId = selectedTopics[i].id;
        questionsPerTopic.set(topicId, questionsPerTopic.get(topicId)! + 1);
      }

      // 3. Fetch questions for each topic concurrently
      const questionPromises = selectedTopics.map((topic) => {
        const count = questionsPerTopic.get(topic.id)!;
        return prisma.question.findMany({
          where: {
            subtopic: { topicId: topic.id },
            humanDifficultyLevel: difficulty,
          },
          take: count,
          select: { id: true },
        });
      });

      const fetchedQuestionBatches = await Promise.all(questionPromises);
      console.log(fetchedQuestionBatches);
      console.log(selectedTopics);

      // 4. Validate that enough questions were found for every topic
      for (let i = 0; i < selectedTopics.length; i++) {
        //@ts-ignore
        const requiredCount = questionsPerTopic.get(selectedTopics[i].id)!;
        //@ts-ignore
        if (fetchedQuestionBatches[i].length < requiredCount) {
          return res.status(400).json({
            success: false,
            error: `Could not find enough '${difficulty}' questions in the selected topics. Please try again.`,
          });
        }
      }

      // 5. Combine and shuffle the final list
      const combinedIds = fetchedQuestionBatches.flat().map((q) => q.id);
      finalQuestionIds = combinedIds.sort(() => 0.5 - Math.random());
    }

    // --- CREATE THE CHALLENGE IN THE DATABASE ---
    const newChallenge = await prisma.challenge.create({
      data: {
        title,
        studyRoomId,
        challengerId: uid,
        topicId: topicIdForChallenge,
        difficulty,
        timeLimit,
        generatedQuestionIds: finalQuestionIds,
        Participants: {
          create: { userId: uid, status: "ACCEPTED" },
        },
      },
    });

    res.status(201).json({
      success: true,
      message: "Challenge created successfully!",
      data: newChallenge,
    });
  } catch (error) {
    console.error("Error creating challenge:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: GET /api/study-group/:studyRoomId/challenges
 * Fetches all active and completed challenges for a given study group.
 */
const getChallenges = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res
        .status(400)
        .json({ success: false, error: "Study room ID is required." });
    }

    const membership = await prisma.studyRoomMember.findUnique({
      where: { studyRoomId_userId: { studyRoomId, userId: uid } },
    });
    if (!membership) {
      return res
        .status(403)
        .json({ success: false, error: "You are not a member of this group." });
    }

    const challenges = await prisma.challenge.findMany({
      where: { studyRoomId },
      include: {
        challenger: { select: { fullName: true } },
        topic: { select: { name: true } },
        _count: { select: { Participants: true } },
        Participants: {
          where: { userId: uid },
          select: {
            status: true,
            userTestInstanceId: true, // Fetch the instance ID
            predictedScore: true, // Fetch prediction
            predictedConfidence: true, // Fetch prediction
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const isChallengeActive = (challenge: (typeof challenges)[0]) => {
      const deadline = new Date(
        challenge.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000
      );
      return new Date() < deadline;
    };

    const formattedChallenges = challenges.map((c) => {
      const userParticipation = c.Participants[0];
      const userStatus = userParticipation?.status
        ? userParticipation.status === "PENDING_ACCEPTANCE"
          ? "NOT_ACCEPTED"
          : userParticipation.status
        : "NOT_ACCEPTED";

      const totalQuestions = Array.isArray(c.generatedQuestionIds)
        ? c.generatedQuestionIds.length
        : 0;

      const userPrediction =
        userParticipation?.predictedScore !== null &&
        userParticipation?.predictedConfidence !== null
          ? {
              score: userParticipation?.predictedScore,
              confidence: userParticipation?.predictedConfidence,
            }
          : null;

      return {
        id: c.id,
        title: c.title,
        topic: c.topic.name,
        difficulty: c.difficulty,
        timeLimit: c.timeLimit,
        creator: c.challenger.fullName || "Unknown",
        participantCount: c._count.Participants,
        totalQuestions: totalQuestions,
        status: isChallengeActive(c) ? "ACTIVE" : "ENDED",
        deadline: new Date(
          c.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000
        ).toISOString(),
        userStatus,
        userTestInstanceId: userParticipation?.userTestInstanceId || null,
        userPrediction, // NEW: Add prediction to response
      };
    });

    res.json({ success: true, data: formattedChallenges });
  } catch (error) {
    console.error("Error fetching challenges:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: POST /api/challenges/:challengeId/accept
 * Allows a user to accept and join a challenge.
 */
const acceptChallenge = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { challengeId } = req.params;

    if (!challengeId) {
      return res
        .status(400)
        .json({ success: false, error: "Challenge ID is required." });
    }

    // Verify the challenge exists and get its study room ID for authorization
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { studyRoomId: true },
    });

    if (!challenge) {
      return res
        .status(404)
        .json({ success: false, error: "Challenge not found." });
    }

    const membership = await prisma.studyRoomMember.findUnique({
      where: {
        studyRoomId_userId: { studyRoomId: challenge.studyRoomId, userId: uid },
      },
    });
    if (!membership) {
      return res.status(403).json({
        success: false,
        error: "You must be a member of the group to accept this challenge.",
      });
    }

    // Use upsert to prevent errors if the user clicks "accept" multiple times
    await prisma.challengeParticipant.upsert({
      where: {
        challengeId_userId: {
          challengeId: challengeId,
          userId: uid,
        },
      },
      update: { status: "ACCEPTED" },
      create: {
        challengeId: challengeId,
        userId: uid,
        status: "ACCEPTED",
      },
    });

    res.json({ success: true, message: "Challenge accepted!" });
  } catch (error) {
    console.error("Error accepting challenge:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: POST /api/challenges/:challengeId/start
 * Creates a UserTestInstanceSummary for a challenge and links it to the participant's record.
 * Returns the new testInstanceId for the frontend to navigate to.
 */
const startChallenge = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { challengeId } = req.params;

    if (!challengeId) {
      return res
        .status(404)
        .json({ success: false, error: "Challenge not found." });
    }
    // 1. Find the challenge and the user's participation record
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
    });
    if (!challenge) {
      return res
        .status(404)
        .json({ success: false, error: "Challenge not found." });
    }

    const participant = await prisma.challengeParticipant.findUnique({
      where: { challengeId_userId: { challengeId, userId: uid } },
    });

    if (!participant) {
      return res.status(403).json({
        success: false,
        error: "You have not accepted this challenge yet.",
      });
    }
    if (participant.userTestInstanceId) {
      return res.status(400).json({
        success: false,
        error: "You have already started this challenge.",
        data: { testInstanceId: participant.userTestInstanceId },
      });
    }
    if (participant.status === "COMPLETED") {
      return res.status(403).json({
        success: false,
        error: "You have already completed this challenge.",
      });
    }

    // 2. Create the unified test instance in a transaction
    const newInstance = await prisma.$transaction(async (tx) => {
      const questionCount = Array.isArray(challenge.generatedQuestionIds)
        ? challenge.generatedQuestionIds.length
        : 0;

      const createdInstance = await tx.userTestInstanceSummary.create({
        data: {
          userId: uid,
          examId: null, // Challenges are not tied to a formal exam
          testName: challenge.title,
          testType: "challenge",
          score: 0,
          totalMarks: questionCount * 4,
          totalQuestions: questionCount,
          numCorrect: 0,
          numIncorrect: 0,
          numUnattempted: questionCount,
          timeTakenSec: 0,
        },
      });

      // 3. Link the new instance back to the participant record
      await tx.challengeParticipant.update({
        where: { challengeId_userId: { challengeId, userId: uid } },
        data: { userTestInstanceId: createdInstance.id },
      });

      return createdInstance;
    });

    res
      .status(201)
      .json({ success: true, data: { testInstanceId: newInstance.id } });
  } catch (error) {
    console.error("Error starting challenge:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: GET /api/challenge-instance/:testInstanceId
 * Fetches the details for a specific challenge attempt, including questions and timing.
 */
const getChallengeTestDetails = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    if (!testInstanceId) {
      return res
        .status(401)
        .json({ success: false, error: "Challenge not found." });
    }

    // 1. Authorize and fetch the instance with its relations
    const testInstance = await prisma.userTestInstanceSummary.findUnique({
      where: { id: testInstanceId, userId: uid },
      include: {
        challengeParticipant: {
          include: {
            challenge: true,
          },
        },
      },
    });

    if (!testInstance || !testInstance.challengeParticipant) {
      return res.status(404).json({
        success: false,
        error: "Challenge test instance not found for this user.",
      });
    }
    if (testInstance.completedAt) {
      return res.status(403).json({
        success: false,
        error: "This challenge has already been completed.",
      });
    }

    const challenge = testInstance.challengeParticipant.challenge;

    // 2. Fetch time already spent from Redis
    const redisKey = `progress:${testInstanceId}`;
    const timeSpentString = await redisClient.hGet(redisKey, "_totalTime");
    const timeSpentSec = parseInt(timeSpentString || "0", 10);

    // 3. Calculate remaining time (challenges have a fixed duration from start)
    const totalDurationSeconds = challenge.timeLimit * 60;
    const timeLimit = Math.max(0, totalDurationSeconds - timeSpentSec);

    // 4. Fetch and format questions
    const questionIds = challenge.generatedQuestionIds as number[];
    if (!Array.isArray(questionIds) || questionIds.length === 0) {
      return res.json({
        success: true,
        data: {
          testInstanceId,
          name: testInstance.testName,
          timeLimit,
          questions: [],
        },
      });
    }

    const questionsFromDb = await prisma.question.findMany({
      where: { id: { in: questionIds } },
      select: {
        id: true,
        question: true,
        imageUrl: true,
        options: true,
        subtopic: {
          select: {
            topic: { select: { subject: { select: { name: true } } } },
          },
        },
      },
    });

    const questionMap = new Map(questionsFromDb.map((q) => [q.id, q]));
    const formattedQuestions = questionIds
      .map((id, index) => {
        const q = questionMap.get(id);
        if (!q) return null;
        const optionsArray =
          q.options &&
          typeof q.options === "object" &&
          !Array.isArray(q.options)
            ? Object.entries(q.options).map(([key, value]) => ({
                label: key,
                value: String(value),
              }))
            : undefined;
        return {
          id: q.id,
          questionNumber: index + 1,
          subject: q.subtopic.topic.subject.name,
          type: optionsArray ? "mcq" : "numerical",
          questionText: q.question,
          options: optionsArray,
          imageUrl: q.imageUrl,
        };
      })
      .filter((q) => q !== null);

    res.json({
      success: true,
      data: {
        testInstanceId,
        name: testInstance.testName,
        timeLimit,
        challengeId: challenge.id,
        questions: formattedQuestions,
      },
    });
  } catch (error) {
    console.error("Error fetching challenge test details:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: POST /api/challenges/:challengeId/predict
 * Allows a user to submit a score prediction for a challenge they have accepted.
 */
const submitPrediction = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { challengeId } = req.params;

    if (!challengeId) {
      return res
        .status(401)
        .json({ success: false, error: "Challenge not found." });
    }

    const validation = submitPredictionSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        errors: validation.error.flatten().fieldErrors,
      });
    }
    const { predictedScore, confidence } = validation.data;

    // 1. Find the user's participation record
    const participant = await prisma.challengeParticipant.findUnique({
      where: { challengeId_userId: { challengeId, userId: uid } },
      include: { challenge: { select: { studyRoomId: true } } },
    });

    // 2. Authorization & Validation
    if (!participant) {
      return res.status(403).json({
        success: false,
        error: "You have not accepted this challenge yet.",
      });
    }
    if (participant.status !== "ACCEPTED") {
      return res.status(400).json({
        success: false,
        error: `You cannot make a prediction on a challenge with '${participant.status}' status.`,
      });
    }
    if (participant.userTestInstanceId) {
      return res.status(400).json({
        success: false,
        error: "You cannot make a prediction after starting the challenge.",
      });
    }

    // 3. Update the record with the prediction
    await prisma.challengeParticipant.update({
      where: { challengeId_userId: { challengeId, userId: uid } },
      data: {
        predictedScore,
        predictedConfidence: confidence,
      },
    });

    res.json({ success: true, message: "Prediction submitted successfully." });
  } catch (error) {
    console.error("Error submitting prediction:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

const submitChallenge = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { challengeId } = req.params; // CHANGED: We now get challengeId from the route

    if (!challengeId) {
      return res
        .status(400)
        .json({ success: false, error: "Challenge ID is required." });
    }

    // --- 1. NEW: Find the Participant Record to get the Test Instance ID ---
    const participant = await prisma.challengeParticipant.findUnique({
      where: { challengeId_userId: { challengeId, userId: uid } },
      include: { challenge: true }, // Include challenge data for question IDs
    });

    // --- 2. NEW: Validation based on the participant record ---
    if (!participant) {
      return res.status(403).json({
        success: false,
        error: "You are not a participant in this challenge.",
      });
    }
    if (participant.status === "COMPLETED") {
      return res.status(400).json({
        success: false,
        error: "You have already completed this challenge.",
      });
    }
    if (!participant.userTestInstanceId) {
      return res.status(400).json({
        success: false,
        error: "You have not started this challenge yet.",
      });
    }

    // --- 3. Extract variables and proceed with the original logic ---
    const testInstanceId = participant.userTestInstanceId;
    const challenge = participant.challenge;
    const questionIds = challenge.generatedQuestionIds as number[];

    // --- 4. Fetch All Progress from Redis ---
    const redisKey = `progress:${testInstanceId}`;
    const [savedProgress, questions] = await Promise.all([
      redisClient.hGetAll(redisKey),
      prisma.question.findMany({
        where: { id: { in: questionIds } },
        select: { id: true, correctOption: true },
      }),
    ]);
    const correctAnswersMap = new Map(
      questions.map((q) => [q.id, q.correctOption])
    );

    // --- 5. Calculate Score and Stats (+1/0 logic) ---
    let numCorrect = 0;
    const answersToSave: any[] = [];
    const totalTimeTakenSec = parseInt(savedProgress._totalTime || "0", 10);
    delete savedProgress._totalTime;

    for (const questionIdStr in savedProgress) {
      const questionId = parseInt(questionIdStr, 10);
      if (!savedProgress[questionIdStr]) {
        return;
      }
      const progress = JSON.parse(savedProgress[questionIdStr]);
      if (progress.answer === null) continue; // Skip unattempted

      console.log(progress, progress.answer, "vfnj");

      const correctAnswer = correctAnswersMap.get(questionId);
      console.log(correctAnswer, "cr");

      const isCorrect =
        correctAnswer !== undefined &&
        String(progress.answer).trim().toUpperCase() ===
          String(correctAnswer).trim().toUpperCase();

      if (isCorrect) {
        numCorrect++;
      }

      answersToSave.push({
        testInstanceId,
        userId: uid,
        questionId,
        userAnswer: progress.answer,
        isCorrect,
        status: isCorrect ? "Correct" : "Incorrect",
        timeTakenSec: Math.round(progress.time || 0),
      });
    }

    const numAttempted = answersToSave.length;
    const numIncorrect = numAttempted - numCorrect;
    const numUnattempted = questionIds.length - numAttempted;
    const finalScore = numCorrect;
    const totalMarks = questionIds.length;

    // --- 6. Atomically Save Results to Database in a Transaction ---
    await prisma.$transaction(async (tx) => {
      // a) Create the detailed answer records
      if (answersToSave.length > 0) {
        await tx.userTestAnswer.createMany({ data: answersToSave });
      }

      // b) Update the main test instance summary
      await tx.userTestInstanceSummary.update({
        where: { id: testInstanceId },
        data: {
          completedAt: new Date(),
          score: finalScore,
          totalMarks: totalMarks,
          numCorrect,
          numIncorrect,
          numUnattempted,
          timeTakenSec: totalTimeTakenSec,
        },
      });

      // c) Update the participant's record
      await tx.challengeParticipant.update({
        where: { challengeId_userId: { challengeId, userId: uid } }, // Can use the main key here
        data: { status: "COMPLETED", completedAt: new Date() },
      });
    });

    // --- 7. Clean Up and Respond ---
    await redisClient.del(redisKey);
    res.json({
      success: true,
      message: "Challenge submitted successfully!",
      data: { score: finalScore, totalMarks },
    });
  } catch (error) {
    console.error("Error submitting challenge:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

const getChallengeResults = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    if (!testInstanceId) {
      return res
        .status(400)
        .json({ success: false, error: "Test Instance ID is required." });
    }

    // 1. Fetch current user's instance to find the challengeId and authorize
    const currentUserInstance = await prisma.userTestInstanceSummary.findFirst({
      where: { id: testInstanceId, userId: uid },
      include: {
        challengeParticipant: { include: { challenge: true } },
      },
    });

    if (
      !currentUserInstance ||
      !currentUserInstance.challengeParticipant?.challengeId
    ) {
      return res.status(404).json({
        success: false,
        error: "Challenge result not found for this user.",
      });
    }

    const { challenge } = currentUserInstance.challengeParticipant;
    const { studyRoomId } = challenge;

    // Authorization... (no changes needed)

    // 2. Fetch ALL completed instances for this challenge
    const allInstances = await prisma.userTestInstanceSummary.findMany({
      where: {
        challengeParticipant: { challengeId: challenge.id },
        completedAt: { not: null },
      },
      include: {
        user: { select: { id: true, fullName: true } },
        challengeParticipant: {
          // FIX 1: Fetch the correct prediction field from the database
          select: { predictedScore: true, predictedConfidence: true },
        },
        answers: true, // Fetch answers, we'll get question details separately
      },
    });

    if (allInstances.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No completed results are available for this challenge yet.",
      });
    }

    // FIX 2: Create a master list of all questions in the challenge.
    // This ensures that even if nobody answers a question, it still appears in the review.
    const masterQuestions = await prisma.question.findMany({
      where: { id: { in: challenge.generatedQuestionIds as number[] } },
      select: {
        id: true,
        question: true,
        options: true,
        correctOption: true,
        solution: true,
        subtopic: {
          select: {
            name: true,
            topic: {
              select: { name: true, subject: { select: { name: true } } },
            },
          },
        },
      },
    });
    const masterQuestionsMap = new Map(masterQuestions.map((q) => [q.id, q]));

    // --- 3. Process Data for the Frontend ---

    // A. Leaderboard & Badges
    const sortedByScore = [...allInstances].sort(
      (a, b) => b.score - a.score || a.timeTakenSec - b.timeTakenSec
    );
    const fastest = [...allInstances].sort(
      (a, b) => a.timeTakenSec - b.timeTakenSec
    )[0];
    const badges: Record<string, string[]> = {};
    allInstances.forEach((inst) => (badges[inst.userId] = []));
    if (sortedByScore[0]) badges[sortedByScore[0].userId]?.push("Top Scorer");
    if (fastest) badges[fastest.userId]?.push("Fastest Solver");

    const leaderboard = sortedByScore.map((inst, index) => {
      const accuracy =
        inst.numCorrect + inst.numIncorrect > 0
          ? (inst.numCorrect / (inst.numCorrect + inst.numIncorrect)) * 100
          : 0;
      const name = inst.user.fullName || "Anonymous User";
      const avatar = name.match(/\b\w/g)?.join("").toUpperCase() || "AU";
      return {
        id: inst.userId,
        rank: index + 1,
        name: name,
        avatar: avatar,
        // FIX 3: Score should be a percentage for the UI
        score:
          inst.totalQuestions > 0
            ? Math.round((inst.numCorrect / inst.totalQuestions) * 100)
            : 0,
        timeCompleted: Math.round(inst.timeTakenSec / 60),
        accuracy: Math.round(accuracy),
        badges: badges[inst.userId] || [],
      };
    });

    // B. Prediction Analysis
    const totalQuestions = challenge.generatedQuestionIds.length;
    const predictionAnalysis = allInstances.map((inst) => {
      // FIX 4: Use the correct field `predictedCorrectCount`
      const prediction = inst.challengeParticipant?.predictedScore;
      const actual = inst.numCorrect;
      const accuracy =
        prediction !== null && prediction !== undefined && totalQuestions > 0
          ? Math.max(
              0,
              (1 - Math.abs(prediction - actual) / totalQuestions) * 100
            )
          : 0;
      const name = inst.user.fullName || "Anonymous User";
      const avatar = name.match(/\b\w/g)?.join("").toUpperCase() || "AU";
      return {
        id: inst.userId,
        name: name,
        avatar: avatar,
        predicted: prediction,
        actual: actual,
        predictionAccuracy: Math.round(accuracy),
      };
    });

    // C. Question Review
    const allAnswersFlat = allInstances.flatMap((inst) => inst.answers);
    const answersByQuestion = new Map<number, any[]>();
    allAnswersFlat.forEach((ans) => {
      if (!answersByQuestion.has(ans.questionId)) {
        answersByQuestion.set(ans.questionId, []);
      }
      answersByQuestion.get(ans.questionId)!.push(ans);
    });

    // FIX 5: Iterate over the MASTER list of questions, not just the answered ones.
    const questionReview = (challenge.generatedQuestionIds as number[])
      .map((qId) => {
        const questionData = masterQuestionsMap.get(qId);
        if (!questionData) return null; // Should not happen, but a good safeguard

        const answersForThisQ = answersByQuestion.get(qId) || [];
        const currentUserAnswer = answersForThisQ.find((a) => a.userId === uid);

        const memberAnswers: Record<string, string | null> = {};
        const optionDistribution: Record<string, number> = {};

        // Iterate over ALL participants to ensure everyone is included for every question.
        allInstances.forEach((instance) => {
          const participantAnswer = answersForThisQ.find(
            (ans) => ans.userId === instance.userId
          );
          const userAnswer = participantAnswer
            ? participantAnswer.userAnswer
            : null;
          memberAnswers[instance.userId] = userAnswer;

          if (userAnswer) {
            optionDistribution[userAnswer] =
              (optionDistribution[userAnswer] || 0) + 1;
          }
        });

        return {
          id: qId,
          questionText: questionData.question,
          subject: questionData.subtopic.topic.subject.name,
          topic: questionData.subtopic.topic.name,
          options: questionData.options,
          correctAnswer: questionData.correctOption,
          explanation: questionData.solution,
          myAnswer: currentUserAnswer?.userAnswer || null,
          isCorrect: currentUserAnswer?.isCorrect || false,
          memberAnswers,
          optionDistribution,
        };
      })
      .filter(Boolean);

    res.json({
      success: true,
      data: {
        challengeDetails: {
          id: challenge.id,
          title: challenge.title,
          totalQuestions,
        },
        leaderboard,
        predictionAnalysis,
        questionReview,
      },
    });
  } catch (error) {
    console.error("Error fetching challenge results:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

export {
  getChallengeOptions,
  createChallenge,
  getChallenges,
  acceptChallenge,
  startChallenge,
  getChallengeTestDetails,
  submitPrediction,
  submitChallenge,
  getChallengeResults,
};
