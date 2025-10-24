import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // Note: Model name updated for clarity, use the one you have access to.

// Schemas for validation (no changes needed here)
const generateScheduleSchema = z.object({
  examId: z.number().int(),
  weekStartDate: z.string().date(),
  topicIds: z
    .array(z.number().int())
    .min(1, "Please select at least one topic."),
  mockDay: z.enum([
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ]),
  weaknessTestDay: z
    .enum([
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
      "SUNDAY",
    ])
    .optional(),
});

const getDailyScheduleSchema = z.object({
  year: z.coerce.number().int().min(2020).max(2050),
  month: z.coerce.number().int().min(1).max(12),
  day: z.coerce.number().int().min(1).max(31),
});

const getScheduleSchema = z.object({
  year: z.coerce.number().int(),
  month: z.coerce.number().int().min(1).max(12),
});

const updateSessionSchema = z.object({
  status: z.enum(["COMPLETED", "SKIPPED"]).optional(),
  newDate: z.string().date().optional(),
});

/**
 * ROUTE: GET /api/schedule/topics/:examId
 * Fetches all subjects and their associated topics for a given exam.
 */
export const getTopicsForScheduling = async (req: Request, res: Response) => {
  try {
    const examId = req.params.examId;
    if (!examId) {
      return res
        .status(404)
        .json({ success: false, error: "Exam ID not found." });
    }
    const examIntId = parseInt(examId);
    if (isNaN(examIntId)) {
      return res
        .status(400)
        .json({ success: false, error: "A valid exam ID is required." });
    }

    const subjectsWithTopics = await prisma.subject.findMany({
      where: { examId: examIntId },
      select: {
        id: true,
        name: true,
        topics: {
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });

    res.status(200).json({ success: true, data: subjectsWithTopics });
  } catch (error) {
    console.error("Error fetching topics for scheduling:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};

/**
 * ROUTE: POST /api/schedule/profile
 * Creates or updates the user's schedule profile for a specific exam.
 */
export const upsertScheduleProfile = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const {
      coachingEndTime,
      coachingStartTime,
      currentLevel,
      dailyAvailableHours,
      examId,
      preferredMockDay,
      studyStyle,
      subjectConfidence,
      examDate,
    } = req.body;

    const profileData = {
      examId,
      coachingEndTime,
      coachingStartTime,
      currentLevel,
      dailyAvailableHours,
      preferredMockDay,
      studyStyle,
      subjectConfidence,
    };

    const profile = await prisma.userScheduleProfile.upsert({
      where: { userId_examId: { userId: uid, examId: examId } },
      create: {
        userId: uid,
        ...profileData,
        examDate: examDate ? new Date(examDate) : null,
      },
      update: {
        ...profileData,
        examDate: examDate ? new Date(examDate) : null,
      },
    });

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error("Error upserting schedule profile:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};

/**
 * ROUTE: POST /api/schedule/generate-week
 * Generates a full 7-day intelligent study cycle using an AI model.
 */
export const generateWeeklySchedule = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { weekStartDate, topicIds, mockDay, weaknessTestDay, examId } =
      req.body;

    // --- 1. GATHER RICH CONTEXT FOR THE AI PROMPT ---
    const [profile, performanceData, allTopics] = await Promise.all([
      prisma.userScheduleProfile.findUnique({
        where: { userId_examId: { userId: uid, examId } },
      }),
      prisma.userTopicPerformance.findMany({
        where: { userId: uid, topicId: { in: topicIds } },
      }),
      prisma.topic.findMany({
        where: { id: { in: topicIds } },
        select: { id: true, name: true, subject: { select: { name: true } } },
      }),
    ]);

    if (!profile) {
      return res
        .status(404)
        .json({ success: false, error: "User schedule profile not found." });
    }

    const performanceMap = new Map(
      performanceData.map((p) => [p.topicId, p.accuracyPercent.toNumber()])
    );
    const topicDetails = allTopics.map((t) => ({
      id: t.id,
      name: t.name,
      subject: t.subject.name,
      userAccuracy: performanceMap.get(t.id) ?? 0,
    }));

    const startDate = new Date(weekStartDate);
    const monthName = startDate.toLocaleString("default", { month: "long" });
    const weekNumber = Math.ceil(startDate.getDate() / 7);

    // --- 2. CONSTRUCT THE PERSONA-DRIVEN, STRATEGIC LLM PROMPT ---
    const llmPrompt = `
      You are an expert AI academic coach for competitive exams. Your task is to generate a highly strategic and personalized 7-day study plan. You must first diagnose the user's status for each selected topic and then create a tailored learning journey.

      **USER PROFILE & CONTEXT:**
      - User's Self-Assessed Overall Level: **${profile.currentLevel}**
      - User's Preferred Study Style: **${profile.studyStyle}**
      - Daily Available Hours (Mon-Sun): ${JSON.stringify(
        profile.dailyAvailableHours
      )}
      - Daily Busy/Coaching Hours: From **${profile.coachingStartTime} to ${
      profile.coachingEndTime
    }** (Do NOT schedule during these times).

      **TOPICS FOR THIS WEEK (CRITICAL ANALYSIS REQUIRED):**
      This is the most important input. It includes the topics the user wants to focus on and their current accuracy.
      ${JSON.stringify(topicDetails, null, 2)}

      **STEP 1: DIAGNOSE THE USER'S PERSONA FOR EACH TOPIC**
      For each topic provided above, you must first classify the user's status based on their accuracy.
      - **"LEARNER" Persona (Accuracy 0-40%):** The user is new to this topic or struggling significantly.
      - **"IMPROVER" Persona (Accuracy 41-85%):** The user has a basic understanding but needs to improve speed and accuracy.
      - **"MASTER" Persona (Accuracy > 85%):** The user is strong in this topic and needs to maintain their edge.

      **STEP 2: PRESCRIBE A LEARNING PATH BASED ON THE PERSONA**
      You must build the weekly schedule by applying the correct learning path for each topic's diagnosed persona.

      --- LEARNING PATH FOR A "LEARNER" ---
      - Priority: Foundational understanding.
      - Sequence: One **THEORY** session, one **CONCEPT_QUIZ**, and at least one **DRILL_EASY**.

      --- LEARNING PATH FOR AN "IMPROVER" ---
      - Priority: Structured practice and accuracy improvement.
      - Sequence: One **REVISION** session, followed by multiple drills progressing in difficulty: **DRILL_EASY** -> **DRILL_MEDIUM**.

      --- LEARNING PATH FOR A "MASTER" ---
      - Priority: Maintenance and advanced testing.
      - Sequence: One brief **REVISION** session and a focus on **DRILL_HARD** sessions.

      **STEP 3: ASSEMBLE THE SCHEDULE**
      - Intelligently place all the prescribed sessions into the available time slots.
      - Mock Test: A 180-minute **MOCK_TEST** is non-negotiable and MUST be scheduled on **${mockDay}**.
      ${
        weaknessTestDay
          ? `- Weakness Test: A 90-minute **WEAKNESS_TEST** is non-negotiable and MUST be scheduled on **${weaknessTestDay}**.`
          : ""
      }
      - Ensure each topic has at least one REVISION session during the week.

      **CRITICAL JSON OUTPUT REQUIREMENTS:**
      Your response must be a valid JSON object with the following structure. Do not include any text, comments, or markdown formatting like \`\`\`json before or after the JSON object. Your entire response must be only the JSON itself.
      {
        "weeklySchedule": [
          {
            "day": 0-6, "startTime": "HH:MM", "durationMinutes": number,
            "method": "THEORY" | "REVISION" | "CONCEPT_QUIZ" | "DRILL_EASY" | "DRILL_MEDIUM" | "DRILL_HARD" | "MOCK_TEST" | "WEAKNESS_TEST",
            "priority": "HIGH" | "MEDIUM" | "LOW", "topicId": number | null,
            "sessionTitle": string | null, "questionCount": number | null,
            "timeLimitMinutes": number | null, "difficultyLevel": "Easy" | "Medium" | "Hard" | null
          }
        ]
      }
      - For Test Sessions ('MOCK_TEST', 'WEAKNESS_TEST'): "topicId" MUST be null, "sessionTitle" MUST be "${monthName} Week-${weekNumber} Mock Test" or "${monthName} Week-${weekNumber} Weakness Test".
      - For Quiz/Drill Sessions: "questionCount", "timeLimitMinutes", and "difficultyLevel" are REQUIRED. durationMinutes should equal timeLimitMinutes.
      - For Study Sessions ('THEORY', 'REVISION'): All test-related parameters must be null. durationMinutes should be 45-90 for THEORY, 30-60 for REVISION.
    `;

    // --- 3. CALL THE LLM AND ROBUSTLY PARSE THE RESPONSE ---
    const result = await model.generateContent(llmPrompt);
    const responseText = result.response.text();

    // Find the start and end of the JSON object to handle conversational text
    const jsonStartIndex = responseText.indexOf("{");
    const jsonEndIndex = responseText.lastIndexOf("}");

    if (jsonStartIndex === -1 || jsonEndIndex === -1) {
      console.error(
        "AI response did not contain a valid JSON object. Response:",
        responseText
      );
      throw new Error(
        "Invalid response format from AI model: No JSON object found."
      );
    }

    const jsonString = responseText.substring(jsonStartIndex, jsonEndIndex + 1);

    let parsedSchedule;
    try {
      parsedSchedule = JSON.parse(jsonString);
    } catch (parseError) {
      console.error("Failed to parse AI response JSON:", jsonString);
      throw new Error("Invalid JSON structure from AI model.");
    }

    // --- 4. VALIDATE AND TRANSFORM THE SCHEDULE ---
    if (
      !parsedSchedule.weeklySchedule ||
      !Array.isArray(parsedSchedule.weeklySchedule)
    ) {
      throw new Error(
        "Invalid schedule structure: 'weeklySchedule' array not found."
      );
    }

    const sessionsToCreate = parsedSchedule.weeklySchedule.map(
      (session: any, index: number) => {
        // Basic validation for required fields
        const requiredFields = [
          "day",
          "startTime",
          "durationMinutes",
          "method",
          "priority",
        ];
        for (const field of requiredFields) {
          if (session[field] === undefined || session[field] === null) {
            throw new Error(
              `Session ${index} is missing required field: ${field}`
            );
          }
        }
        if (session.day < 0 || session.day > 6) {
          throw new Error(
            `Session ${index} has an invalid day: ${session.day}. Must be 0-6.`
          );
        }

        const sessionDate = new Date(weekStartDate);
        sessionDate.setDate(sessionDate.getDate() + session.day);

        if (isNaN(sessionDate.getTime())) {
          throw new Error(`Invalid date calculated for session ${index}`);
        }

        return {
          userId: uid,
          topicId: session.topicId ?? null,
          sessionTitle: session.sessionTitle ?? null,
          date: sessionDate,
          startTime: session.startTime,
          durationMinutes: session.durationMinutes,
          method: session.method,
          priority: session.priority,
          status: "PENDING",
          questionCount: session.questionCount ?? null,
          timeLimitMinutes: session.timeLimitMinutes ?? null,
          difficultyLevel: session.difficultyLevel ?? null,
        };
      }
    );

    if (sessionsToCreate.length === 0) {
      throw new Error("No valid sessions were generated by the AI model.");
    }

    // --- 5. SAVE TO DATABASE ---
    await prisma.$transaction(async (tx) => {
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 7);

      await tx.scheduledSession.deleteMany({
        where: { userId: uid, date: { gte: startDate, lt: endDate } },
      });

      await tx.scheduledSession.createMany({ data: sessionsToCreate });
    });

    res.status(201).json({
      success: true,
      message: "AI-powered intelligent study cycle has been generated.",
      sessionsCreated: sessionsToCreate.length,
    });
  } catch (error: any) {
    console.error("Error generating AI weekly schedule:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error.",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * ROUTE: GET /api/schedule/month?year=...&month=...
 * Fetches all scheduled sessions for a given month.
 */
export const getMonthlySchedule = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const validation = getScheduleSchema.safeParse(req.query);

    if (!validation.success) {
      return res
        .status(400)
        .json({ success: false, error: validation.error.flatten() });
    }

    const { year, month } = validation.data;
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 1));

    const sessions = await prisma.scheduledSession.findMany({
      where: { userId: uid, date: { gte: startDate, lt: endDate } },
      include: {
        topic: { select: { name: true, subject: { select: { name: true } } } },
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
    });

    const scheduleData = sessions.reduce((acc: any, session) => {
      const day = new Date(session.date).getUTCDate();
      if (!acc[day]) {
        acc[day] = [];
      }
      acc[day].push({
        id: session.id,
        subject: session.topic?.subject.name || "General",
        topicId: session.topicId,
        topic: session.topic?.name || session.sessionTitle || "General Task",
        priority: session.priority,
        method: session.method,
        duration: session.durationMinutes,
        time: session.startTime,
        status: session.status,
        questionCount: session.questionCount,
        timeLimitMinutes: session.timeLimitMinutes,
        difficultyLevel: session.difficultyLevel,
      });
      return acc;
    }, {});

    res.status(200).json({ success: true, data: scheduleData });
  } catch (error) {
    console.error("Error fetching monthly schedule:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};

/**
 * ROUTE: GET /api/schedule/day?year=...&month=...&day=...
 * Fetches all scheduled sessions for a given day.
 */
export const getDailySchedule = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;

    const validation = getDailyScheduleSchema.safeParse(req.query);

    if (!validation.success) {
      return res
        .status(400)
        .json({ success: false, error: validation.error.flatten() });
    }

    const { year, month, day } = validation.data;

    const startDate = new Date(Date.UTC(year, month - 1, day));
    const endDate = new Date(Date.UTC(year, month - 1, day + 1));

    const sessions = await prisma.scheduledSession.findMany({
      where: {
        userId: uid,
        date: {
          gte: startDate,
          lt: endDate,
        },
      },
      include: {
        topic: { select: { name: true, subject: { select: { name: true } } } },
      },
      orderBy: {
        startTime: "asc",
      },
    });

    const scheduleData = sessions.map((session) => ({
      id: session.id,
      subject: session.topic?.subject.name || "General",
      topicId: session.topicId,
      topic: session.topic?.name || session.sessionTitle || "General Task",
      priority: session.priority,
      method: session.method,
      duration: session.durationMinutes,
      time: session.startTime,
      status: session.status,
      questionCount: session.questionCount,
      timeLimitMinutes: session.timeLimitMinutes,
      difficultyLevel: session.difficultyLevel,
    }));

    res.status(200).json({ success: true, data: scheduleData });
  } catch (error) {
    console.error("Error fetching daily schedule:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};

/**
 * ROUTE: PATCH /api/schedule/session/:sessionId
 * Updates a single session (e.g., marks as complete, reschedules).
 */
export const updateSession = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { sessionId } = req.params;

    if (!sessionId) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid or missing sessionId." });
    }

    const validation = updateSessionSchema.safeParse(req.body);
    if (!validation.success) {
      return res
        .status(400)
        .json({ success: false, error: validation.error.flatten() });
    }
    const { status, newDate } = validation.data;

    const session = await prisma.scheduledSession.findFirst({
      where: { id: sessionId, userId: uid },
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: "Session not found or you do not have permission to edit it.",
      });
    }

    const dataToUpdate: { status?: "COMPLETED" | "SKIPPED"; date?: Date } = {};
    if (status) dataToUpdate.status = status;
    if (newDate) dataToUpdate.date = new Date(newDate);

    const updatedSession = await prisma.scheduledSession.update({
      where: { id: sessionId },
      data: dataToUpdate,
    });

    res.status(200).json({ success: true, data: updatedSession });
  } catch (error) {
    console.error("Error updating session:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};

/**
 * ROUTE: GET /api/schedule/profile/:examId
 * Fetches a user's saved schedule profile for a specific exam.
 */
export const getScheduleProfile = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const examId = req.params.examId;

    if (!examId) {
      return res
        .status(400)
        .json({ success: false, error: "Exam ID is required." });
    }

    const intExamId = parseInt(examId);
    if (isNaN(intExamId)) {
      return res.status(400).json({
        success: false,
        error: "A valid numeric Exam ID is required.",
      });
    }

    const profile = await prisma.userScheduleProfile.findUnique({
      where: {
        userId_examId: {
          userId: uid,
          examId: intExamId,
        },
      },
    });

    if (!profile) {
      return res.status(404).json({
        success: false,
        error:
          "Schedule profile not found for this user and exam. Please create one.",
      });
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error("Error fetching schedule profile:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};
