import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { videoQueue } from "../queues/videoQueue.js";

const prisma = new PrismaClient();

const generate = async (req: Request, res: Response) => {
  const { questionId } = req.body;

  if (!questionId) {
    return res.status(400).json({ error: "questionId is required" });
  }

  // A more robust check for a valid number
  const questionIdNum = parseInt(questionId, 10);
  if (isNaN(questionIdNum)) {
    return res.status(400).json({ error: "questionId must be a valid number" });
  }

  try {
    // --- START OF MODIFICATION ---
    // 1. Check for an existing, completed job for this questionId
    const existingJob = await prisma.videoGenerationJob.findFirst({
      where: {
        questionId: questionIdNum,
        status: "COMPLETED",
        videoUrl: { not: null },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (existingJob) {
      console.log(
        `[Cache Hit] Found existing completed job ${existingJob.id} for question ${questionIdNum}.`
      );

      return res.status(200).json({
        jobId: existingJob.id,
        status: existingJob.status,
        videoUrl: existingJob.videoUrl,
        message: "Returning existing completed video job.",
      });
    }

    console.log(
      `[Cache Miss] No completed job for question ${questionIdNum}. Creating new job.`
    );

    // Create the job record in the database
    const newJobRecord = await prisma.videoGenerationJob.create({
      data: {
        questionId: questionIdNum,
        status: "PENDING",
      },
    });

    const jobId = newJobRecord.id;
    await videoQueue.add("generate-video", {
      jobId,
      questionId: questionIdNum,
    });

    console.log(
      `Job ${jobId} for question ${questionIdNum} added to the queue.`
    );

    res.status(202).json({ jobId });
  } catch (error) {
    console.error("Failed to create or find job:", error);
    res
      .status(500)
      .json({ error: "Could not create or find the video generation job." });
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

    res.status(200).json({ success: true, jobRecord });
  } catch (error) {
    console.error("Failed to get job status:", error);
    res.status(500).json({ error: "Could not retrieve job status." });
  }
};

export { generate, VideoStatus };
