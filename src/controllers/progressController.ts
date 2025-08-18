import { redisClient } from "../config/redis.js";
import { prisma } from "../services/db.js";
import type { Request, Response } from "express";

const saveTestProgress = async (req: Request, res: Response) => {
  try {
    const { testInstanceId } = req.params;
    const { questionId, userAnswer, timeSpentChunk } = req.body;

    if (!testInstanceId || !questionId || timeSpentChunk === undefined) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const redisKey = `progress:${testInstanceId}`;

    const existingData = await redisClient.hGet(redisKey, String(questionId));
    let currentProgress = { answer: null, time: 0 };
    if (existingData) {
      currentProgress = JSON.parse(existingData);
    }

    currentProgress.answer = userAnswer;
    currentProgress.time += timeSpentChunk;

    await redisClient.hSet(
      redisKey,
      String(questionId),
      JSON.stringify(currentProgress)
    );

    // 2. Atomically increment the total time spent for the entire test
    if (timeSpentChunk > 0) {
      await redisClient.hIncrBy(
        redisKey,
        "_totalTime",
        Math.round(timeSpentChunk)
      );
    }

    res.json({ success: true, message: "Progress saved." });
  } catch (error) {
    console.error("Error saving test progress:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getTestProgress = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    if (!uid) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    if (!testInstanceId) {
      return res.status(400).json({ error: "Test instance ID is required" });
    }

    // First, verify that this user is actually the one taking this test
    const testInstance = await prisma.userTestInstanceSummary.findFirst({
      where: {
        id: testInstanceId,
        userId: uid,
      },
      select: { id: true, completedAt: true },
    });

    if (!testInstance) {
      return res
        .status(404)
        .json({ error: "Test instance not found for this user." });
    }
    if (testInstance.completedAt) {
      return res
        .status(403)
        .json({ error: "This test has already been completed." });
    }

    // If validation passes, fetch the progress from Redis
    const redisKey = `progress:${testInstanceId}`;
    const savedProgress = await redisClient.hGetAll(redisKey);

    // If no progress is found, return an empty object
    if (!savedProgress || Object.keys(savedProgress).length === 0) {
      return res.json({ success: true, data: { answers: {}, totalTime: 0 } });
    }

    // Parse the data into a clean format for the frontend
    const totalTime = parseFloat(savedProgress._totalTime || "0");
    delete savedProgress._totalTime;

    const answers = Object.entries(savedProgress).reduce(
      (acc, [questionId, data]) => {
        const { answer } = JSON.parse(data);
        if (answer) {
          acc[questionId] = answer;
        }
        return acc;
      },
      {} as Record<string, string>
    );

    res.json({
      success: true,
      data: {
        answers,
        totalTime,
      },
    });
  } catch (error) {
    console.error("Error fetching test progress:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export { saveTestProgress, getTestProgress };
