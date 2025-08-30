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
    z.literal(3),
    z.literal(6),
    z.literal(9),
    z.literal(12),
    z.literal(15),
  ]),
});

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
      },
      orderBy: { createdAt: "desc" },
    });

    const formattedChallenges = challenges.map((c: any) => ({
      id: c.id,
      title: c.title,
      topic: c.topic.name,
      difficulty: c.difficulty,
      timeLimit: c.timeLimit,
      creator: c.challenger.fullName,
      participants: c._count.participants,
      status: c.status === "COMPLETED" ? "completed" : "active",
      deadline: new Date(
        c.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000
      ).toISOString(), // Example deadline: 7 days after creation
    }));

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
        .status(404)
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

interface ChallengeAnswerPayload {
  questionId: number;
  userAnswer: string | null; // Can be null if skipped
  timeTakenSec: number;
}

export const submitChallenge = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user; // Assuming auth middleware provides this
    const { challengeId } = req.params;
    const answers: ChallengeAnswerPayload[] = req.body.answers;

    if (!challengeId) {
      return res
        .status(404)
        .json({ success: false, error: "Challenge not found." });
    }

    // --- 1. Initial Validation ---
    if (!answers || !Array.isArray(answers) || answers.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid or empty submission." });
    }

    // --- 2. Fetch Challenge & Validate User Status ---
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
      include: {
        // We only need question IDs and correct answers for scoring
        questions: { select: { id: true, correctOption: true } },
        participants: {
          where: { userId: uid },
          select: { hasCompleted: true },
        },
      },
    });

    if (!challenge) {
      return res
        .status(404)
        .json({ success: false, error: "Challenge not found." });
    }
    if (challenge.participants.length === 0) {
      return res.status(403).json({
        success: false,
        error: "You are not a participant in this challenge.",
      });
    }
    if (challenge.participants[0].hasCompleted) {
      return res.status(400).json({
        success: false,
        error: "You have already completed this challenge.",
      });
    }

    // --- 3. Score Calculation ---
    const correctAnswersMap = new Map(
      challenge.questions.map((q) => [q.id, q.correctOption])
    );

    let score = 0;
    let totalTimeTaken = 0;
    let numCorrect = 0;
    let numIncorrect = 0;
    const submittedQuestionIds = new Set(answers.map((a) => a.questionId));

    for (const answer of answers) {
      totalTimeTaken += answer.timeTakenSec;
      const correctOption = correctAnswersMap.get(answer.questionId);

      if (correctOption && answer.userAnswer === correctOption) {
        score += 4; // Standard scoring: +4 for correct
        numCorrect++;
      } else if (answer.userAnswer !== null) {
        score -= 1; // -1 for incorrect
        numIncorrect++;
      }
    }

    const numUnattempted = correctAnswersMap.size - submittedQuestionIds.size;

    // --- 4. Update Leaderboard in Redis ---
    // Redis Sorted Sets are perfect for real-time leaderboards.
    // The key is unique to this challenge.
    const leaderboardKey = `challenge:leaderboard:${challengeId}`;
    await redisClient.zAdd(leaderboardKey, score, uid);

    // --- 5. Atomically Save Results to Database ---
    // Using a transaction ensures that we either save everything or nothing,
    // maintaining data integrity.
    await prisma.$transaction([
      // Create a record for each individual answer for detailed review later
      prisma.challengeAnswer.createMany({
        data: answers.map((ans) => ({
          challengeId: challengeId,
          userId: uid,
          questionId: ans.questionId,
          userAnswer: ans.userAnswer,
          timeTakenSec: ans.timeTakenSec,
          isCorrect: correctAnswersMap.get(ans.questionId) === ans.userAnswer,
        })),
      }),
      // Update the user's participation record with their final score and status
      prisma.challengeParticipant.update({
        where: {
          challengeId_userId: {
            // Assumes a composite key on the model
            challengeId: challengeId,
            userId: uid,
          },
        },
        data: {
          score,
          timeTakenSec: totalTimeTaken,
          numCorrect,
          numIncorrect,
          numUnattempted,
          hasCompleted: true,
          completedAt: new Date(),
        },
      }),
    ]);

    // --- 6. Get User's Rank from Redis ---
    // ZREVRANK gives the rank from highest score to lowest (0-indexed).
    const rank = await redisClient.zRevRank(leaderboardKey, uid);

    // --- 7. Send Final Response ---
    res.status(200).json({
      success: true,
      message: "Challenge submitted successfully!",
      data: {
        score,
        totalTimeTaken,
        numCorrect,
        numIncorrect,
        numUnattempted,
        rank: rank !== null ? rank + 1 : null, // Convert 0-indexed to 1-indexed
      },
    });
  } catch (error) {
    console.error("Error submitting challenge:", error);
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
};
