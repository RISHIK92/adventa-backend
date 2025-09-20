import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { videoQueue } from "../queues/videoQueue.js";

const prisma = new PrismaClient();

const generate = async (req: Request, res: Response) => {
  const { questionId } = req.body;

  if (!questionId) {
    return res.status(400).json({ error: "questionId is required" });
  }

  try {
    // 1. Create the job record in the database
    const jobRecord = await prisma.videoGenerationJob.create({
      data: {
        questionId: parseInt(questionId),
        status: "PENDING",
      },
    });

    // 2. Add the job to the BullMQ queue
    const jobId = jobRecord.id;
    await videoQueue.add("generate-video", { jobId, questionId });

    console.log(`Job ${jobId} for question ${questionId} added to the queue.`);

    // 3. Return the jobId to the client
    res.status(202).json({ jobId });
  } catch (error) {
    console.error("Failed to create job:", error);
    res
      .status(500)
      .json({ error: "Could not create the video generation job." });
  }
};

// Route for the frontend to poll the job status
const VideoStatus = async (req: Request, res: Response) => {
  const { jobId } = req.params;

  if (!jobId) {
    return res.status(400).json({ error: "jobId is required" });
  }

  try {
    const jobRecord = await prisma.videoGenerationJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        status: true,
        videoUrl: true,
        errorMessage: true,
        retryCount: true,
      },
    });

    if (!jobRecord) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json(jobRecord);
  } catch (error) {
    console.error("Failed to get job status:", error);
    res.status(500).json({ error: "Could not retrieve job status." });
  }
};

export { generate, VideoStatus };
