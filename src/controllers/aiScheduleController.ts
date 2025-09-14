import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { date, z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Add this schema to the top of the file
const generateScheduleSchema = z.object({
  examId: z.number().int(),
  weekStartDate: z.string().date(), // "YYYY-MM-DD"
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

const getScheduleSchema = z.object({
  year: z.coerce.number().int(),
  month: z.coerce.number().int().min(1).max(12),
});

const updateSessionSchema = z.object({
  status: z.enum(["COMPLETED", "SKIPPED"]).optional(),
  newDate: z.string().date().optional(),
});

/**
 * ROUTE: POST /api/schedule/profile
 * Creates or updates the user's schedule profile for a specific exam.
 */
export const upsertScheduleProfile = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;

    const validation = req.body;
    if (!validation.success) {
      return res
        .status(400)
        .json({ success: false, error: validation.error.flatten() });
    }

    const profileData = validation.data;

    const profile = await prisma.userScheduleProfile.upsert({
      where: { userId_examId: { userId: uid, examId: profileData.examId } },
      create: {
        userId: uid,
        ...profileData,
        examDate: profileData.examDate
          ? new Date(profileData.examDate)
          : undefined,
      },
      update: {
        ...profileData,
        examDate: profileData.examDate
          ? new Date(profileData.examDate)
          : undefined,
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

    // --- 2. CONSTRUCT THE SOPHISTICATED LLM PROMPT ---
    const llmPrompt = `
      You are an expert AI academic coach. Your task is to generate a structured 7-day study plan that follows a specific pedagogical cycle: Revise -> Concept Quiz -> Drill.

      **User Context:**
      - Current Level: ${profile.currentLevel}
      - Daily Available Hours (Mon-Sun): ${JSON.stringify(
        profile.dailyAvailableHours
      )}
      - Busy Hours: From ${profile.coachingStartTime} to ${
      profile.coachingEndTime
    }
      - Topics to focus on this week (with user's current accuracy): ${JSON.stringify(
        topicDetails,
        null,
        2
      )}
      
      **High-Level Plan for the Week:**
      1.  **Day 1 (Revision):** Create REVISION sessions for all the specified topics. These are theory-focused.
      2.  **Day 2 (Concept Quizzes):** Create a separate CONCEPT_QUIZ session for EACH of the specified topics.
      3.  **Subsequent Days (Drills):** Fill the remaining days with DRILL_EASY, DRILL_MEDIUM, and DRILL_HARD practice sessions for the topics. Prioritize weaker topics (lower accuracy) for more drill sessions.
      4.  **Mock Test:** Schedule a 180-minute MOCK_TEST session on ${mockDay}.
      ${
        weaknessTestDay
          ? `5. **Weakness Test:** Schedule a 90-minute WEAKNESS_TEST session on ${weaknessTestDay}.`
          : ""
      }

      **Instructions:**
      - Create sessions for all 7 days (day 0 = Monday, day 6 = Sunday).
      - Allocate sessions into available time slots outside of the busy hours.
      - A session's 'method' MUST be one of: REVISION, CONCEPT_QUIZ, DRILL_EASY, DRILL_MEDIUM, DRILL_HARD, MOCK_TEST, WEAKNESS_TEST.
      - For MOCK_TEST and WEAKNESS_TEST sessions:
          - Set 'topicId' to null.
          - Set 'sessionTitle' to "${monthName} Week-${weekNumber} Mock Test" or "${monthName} Week-${weekNumber} Weakness Test".
      - For all other sessions:
          - 'topicId' MUST be one of the provided topic IDs.
          - 'sessionTitle' should be null.
      - Respond ONLY with a valid JSON object. Do not include any other text.
      
      **JSON Output Format:**
      {
        "weeklySchedule": [
          { "day": 0, "startTime": "07:00", "durationMinutes": 60, "topicId": 101, "sessionTitle": null, "method": "REVISION", "priority": "HIGH" },
          { "day": 1, "startTime": "19:00", "durationMinutes": 45, "topicId": 101, "sessionTitle": null, "method": "CONCEPT_QUIZ", "priority": "HIGH" },
          { "day": 5, "startTime": "09:00", "durationMinutes": 180, "topicId": null, "sessionTitle": "${monthName} Week-${weekNumber} Mock Test", "method": "MOCK_TEST", "priority": "HIGH" }
        ]
      }
    `;

    // --- 3. CALL THE LLM AND PARSE THE RESPONSE ---
    const result = await model.generateContent(llmPrompt);
    const responseText = result.response.text().replace(/```json|```/g, "");
    const parsedSchedule = JSON.parse(responseText);

    const sessionsToCreate = parsedSchedule.weeklySchedule.map(
      (session: any) => {
        const sessionDate = new Date(weekStartDate);
        // The AI returns day as 0-6 (Mon-Sun), adjust for JS Date's 0-6 (Sun-Sat) if needed.
        // Assuming your weekStartDate is always a Monday, this is simpler:
        sessionDate.setDate(sessionDate.getDate() + session.day);

        return {
          userId: uid,
          topicId: session.topicId, // This can now be null
          sessionTitle: session.sessionTitle, // New field
          date: sessionDate,
          startTime: session.startTime,
          durationMinutes: session.durationMinutes,
          method: session.method,
          priority: session.priority,
          status: "PENDING",
        };
      }
    );

    // --- 4. SAVE TO DATABASE ---
    await prisma.$transaction(async (tx) => {
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 7);
      await tx.scheduledSession.deleteMany({
        where: { userId: uid, date: { gte: startDate, lt: endDate } },
      });

      if (sessionsToCreate.length > 0) {
        await tx.scheduledSession.createMany({ data: sessionsToCreate });
      }
    });

    res.status(201).json({
      success: true,
      message: "AI-powered intelligent study cycle has been generated.",
    });
  } catch (error) {
    console.error("Error generating AI weekly schedule:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
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
      where: {
        userId: uid,
        date: { gte: startDate, lt: endDate },
      },
      include: {
        topic: { select: { name: true, subject: { select: { name: true } } } },
      },
      orderBy: { date: "asc" },
    });

    // Group sessions by day for easier frontend consumption
    const scheduleData = sessions.reduce((acc: any, session) => {
      const day = new Date(session.date).getUTCDate();
      if (!acc[day]) {
        acc[day] = [];
      }
      acc[day].push({
        id: session.id,
        subject: session.topic.subject.name,
        topic: session.topic.name,
        priority: session.priority,
        method: session.method,
        duration: session.durationMinutes,
        time: session.startTime,
        completed: session.status === "COMPLETED",
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
 * ROUTE: PATCH /api/schedule/session/:sessionId
 * Updates a single session (e.g., marks as complete, reschedules).
 */
export const updateSession = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { sessionId } = req.params;

    if (!sessionId || isNaN(Number(sessionId))) {
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

    // Security: Ensure the session belongs to the user before updating
    const session = await prisma.scheduledSession.findFirst({
      where: { id: sessionId, userId: uid },
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: "Session not found or you do not have permission to edit it.",
      });
    }

    const data: any = {
      status,
    };

    if (newDate) {
      data.date = new Date(newDate);
    }

    const updatedSession = await prisma.scheduledSession.update({
      where: { id: sessionId },
      data,
    });

    res.status(200).json({ success: true, data: updatedSession });
  } catch (error) {
    console.error("Error updating session:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};
