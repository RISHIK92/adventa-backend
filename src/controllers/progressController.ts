import { redisClient } from "../config/redis.js";
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

    currentProgress.answer = userAnswer; // Update with the latest answer
    currentProgress.time += timeSpentChunk; // Accumulate time for the question

    await redisClient.hSet(
      redisKey,
      String(questionId),
      JSON.stringify(currentProgress)
    );

    // 2. Atomically increment the total time spent for the entire test
    if (timeSpentChunk > 0) {
      await redisClient.hIncrByFloat(redisKey, "_totalTime", timeSpentChunk);
    }

    res.json({ success: true, message: "Progress saved." });
  } catch (error) {
    console.error("Error saving test progress:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export { saveTestProgress };
