import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { date, success, z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
 * ROUTE: GET /api/schedule/topics/:examId
 * Fetches all subjects and their associated topics for a given exam,
 * used to populate the week planning modal.
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
          select: {
            id: true,
            name: true,
          },
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
        examDate: examDate && new Date(examDate),
      },
      update: {
        ...profileData,
        examDate: examDate && new Date(examDate),
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

      // =================================================================
      //                 *** YOUR CORE LOGIC AND STRATEGY ***
      // =================================================================

      **STEP 1: DIAGNOSE THE USER'S PERSONA FOR EACH TOPIC**
      For each topic provided above, you must first classify the user's status based on their accuracy.
      - **"LEARNER" Persona (Accuracy 0-40%):** The user is new to this topic or struggling significantly. They are likely learning it simultaneously at their coaching center. The plan must focus on building a foundation.
      - **"IMPROVER" Persona (Accuracy 41-85%):** The user has a basic understanding but needs to improve speed, accuracy, and problem-solving skills. The plan must focus on structured practice and reinforcement.
      - **"MASTER" Persona (Accuracy > 85%):** The user is strong in this topic and needs to maintain their edge and tackle advanced problems.

      **STEP 2: PRESCRIBE A LEARNING PATH BASED ON THE PERSONA**
      You must build the weekly schedule by applying the correct learning path for each topic's diagnosed persona.

      --- LEARNING PATH FOR A "LEARNER" ---
      - **Priority:** Foundational understanding.
      - **Sequence:**
          1.  One mandatory **THEORY** session early in the week (e.g., Day 0 or 1). This is for deep conceptual learning.
          2.  One mandatory **CONCEPT_QUIZ** session mid-week to check understanding.
          4.   add one **DRILL_EASY** session for chapters that needs practice more that concept.

      --- LEARNING PATH FOR AN "IMPROVER" ---
      - **Priority:** Structured practice and accuracy improvement.
      - **Sequence:**
          1.  One mandatory **REVISION** session early in the week to refresh concepts.
          2.  Multiple drill sessions, progressing in difficulty: **DRILL_EASY** -> **DRILL_MEDIUM**. A **DRILL_HARD** session is optional if their accuracy is on the higher end (>70%).
          3.  More practice sessions than theory sessions.

      --- LEARNING PATH FOR A "MASTER" ---
      - **Priority:** Maintenance and advanced testing.
      - **Sequence:**
          1.  One brief **REVISION** session.
          2.  Focus entirely on **DRILL_HARD** sessions to challenge their knowledge.
          3.  No need for CONCEPT_QUIZ or easy/medium drills.

      **STEP 3: ASSEMBLE THE SCHEDULE**
      - Intelligently place all the prescribed sessions into the available time slots across the 7 days.
      - **Mock Test:** A 180-minute **MOCK_TEST** is non-negotiable and MUST be scheduled on **${mockDay}**.
      ${
        weaknessTestDay
          ? `- **Weakness Test:** A 90-minute **WEAKNESS_TEST** is non-negotiable and MUST be scheduled on **${weaknessTestDay}**.`
          : ""
      }
      - Ensure each topic has at least one REVISION session during the week.

      **CRITICAL JSON OUTPUT REQUIREMENTS:**
      Your response must be a valid JSON object with the following structure:
      {
        "weeklySchedule": [
          {
            "day": 0-6, // REQUIRED: 0=Monday, 1=Tuesday, ..., 6=Sunday
            "startTime": "HH:MM", // REQUIRED: 24-hour format like "09:00"
            "durationMinutes": number, // REQUIRED: session duration in minutes
            "method": "string", // REQUIRED: THEORY, REVISION, CONCEPT_QUIZ, DRILL_EASY, DRILL_MEDIUM, DRILL_HARD, MOCK_TEST, WEAKNESS_TEST
            "priority": "string", // REQUIRED: HIGH, MEDIUM, LOW
            "topicId": number or null, // null for MOCK_TEST/WEAKNESS_TEST, valid topicId for others
            "sessionTitle": "string" or null, // Required for MOCK_TEST/WEAKNESS_TEST, null for others
            "questionCount": number or null, // Required for quiz/drill sessions, null for theory/revision/tests
            "timeLimitMinutes": number or null, // Required for quiz/drill sessions, null for theory/revision/tests
            "difficultyLevel": "string" or null // Required for drill sessions (Easy/Medium/Hard), null for others
          }
        ]
      }

      - **For Test Sessions ('MOCK_TEST', 'WEAKNESS_TEST'):**
          - "topicId" MUST be null.
          - "sessionTitle" MUST be "${monthName} Week-${weekNumber} Mock Test" or "${monthName} Week-${weekNumber} Weakness Test".
          - All test parameters ("questionCount", "timeLimitMinutes", "difficultyLevel") MUST be null.
          - "durationMinutes" should be 180 for MOCK_TEST, 90 for WEAKNESS_TEST.
      - **For Topic-Specific Test Sessions ('CONCEPT_QUIZ', 'DRILL_*'):**
          - You MUST include "questionCount" (5-15), "timeLimitMinutes" (10-25), and "difficultyLevel".
          - "difficultyLevel" MUST match the drill type (e.g., "Easy" for DRILL_EASY).
          - "topicId" MUST be a valid ID from the context.
          - "sessionTitle" MUST be null.
          - "durationMinutes" should match "timeLimitMinutes".
      - **For Study Sessions ('THEORY', 'REVISION'):**
          - All test parameters ("questionCount", "timeLimitMinutes", "difficultyLevel") MUST be null.
          - "topicId" MUST be a valid ID from the context.
          - "sessionTitle" MUST be null.
          - "durationMinutes" should be 45-90 minutes for THEORY, 30-60 for REVISION.

      Now, execute your diagnosis and prescription logic to generate the optimal weekly schedule as a JSON object. Make sure ALL required fields are included for every session.
    `;

    // --- 3. CALL THE LLM AND PARSE THE RESPONSE ---
    const result = await model.generateContent(llmPrompt);
    const responseText = result.response
      .text()
      .replace(/```json|```/g, "")
      .trim();

    // Add validation before parsing
    if (!responseText) {
      throw new Error("Empty response from AI model");
    }

    let parsedSchedule;
    try {
      parsedSchedule = JSON.parse(responseText);
    } catch (parseError) {
      console.error("Failed to parse AI response:", responseText);
      throw new Error("Invalid JSON response from AI model");
    }

    // Validate the parsed schedule structure
    if (
      !parsedSchedule.weeklySchedule ||
      !Array.isArray(parsedSchedule.weeklySchedule)
    ) {
      throw new Error("Invalid schedule structure from AI model");
    }

    const sessionsToCreate = parsedSchedule.weeklySchedule.map(
      (session: any, index: number) => {
        // Validate required fields
        const requiredFields = [
          "day",
          "startTime",
          "durationMinutes",
          "method",
          "priority",
        ];
        const missingFields = requiredFields.filter(
          (field) => session[field] === undefined || session[field] === null
        );

        if (missingFields.length > 0) {
          throw new Error(
            `Session ${index} is missing required fields: ${missingFields.join(
              ", "
            )}`
          );
        }

        // Validate day is within range and fix if needed
        if (session.day < 0 || session.day > 6) {
          // If day is 7, convert it to 0 (Sunday becomes Monday of next week, but we'll treat it as Sunday of current week)
          if (session.day === 7) {
            console.warn(
              `Session ${index} had day 7, converting to day 6 (Sunday)`
            );
            session.day = 6;
          } else {
            throw new Error(
              `Session ${index} has invalid day: ${session.day}. Must be 0-6 (Monday-Sunday).`
            );
          }
        }

        // Calculate the session date
        const sessionDate = new Date(weekStartDate);
        sessionDate.setDate(sessionDate.getDate() + session.day);

        // Validate the calculated date
        if (isNaN(sessionDate.getTime())) {
          throw new Error(`Invalid date calculated for session ${index}`);
        }

        return {
          userId: uid,
          topicId: session.topicId,
          sessionTitle: session.sessionTitle,
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

    // Additional validation: check if we have sessions
    if (sessionsToCreate.length === 0) {
      throw new Error("No valid sessions were generated by the AI model");
    }

    // Log the sessions for debugging (remove in production)
    console.log(
      "Sessions to create:",
      JSON.stringify(sessionsToCreate, null, 2)
    );

    // --- 4. SAVE TO DATABASE ---
    await prisma.$transaction(async (tx) => {
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 7);

      // Delete existing sessions for the week
      await tx.scheduledSession.deleteMany({
        where: { userId: uid, date: { gte: startDate, lt: endDate } },
      });

      // Create new sessions
      if (sessionsToCreate.length > 0) {
        await tx.scheduledSession.createMany({ data: sessionsToCreate });
      }
    });

    res.status(201).json({
      success: true,
      message: "AI-powered intelligent study cycle has been generated.",
      sessionsCreated: sessionsToCreate.length,
    });
  } catch (error) {
    console.error("Error generating AI weekly schedule:", error);

    // Provide more specific error messages
    let errorMessage = "Internal server error.";

    res.status(500).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === "development" ? error : undefined,
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
        subject: session.topic?.subject.name || "Mock Test",
        topicId: session.topicId,
        topic: session.topic?.name || "Test",
        priority: session.priority,
        method: session.method,
        duration: session.durationMinutes,
        time: session.startTime,
        completed: session.status === "COMPLETED",
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

/**
 * ROUTE: GET /api/schedule/profile/:examId
 * Fetches a user's saved schedule profile for a specific exam.
 */
export const getScheduleProfile = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const examId = req.params.examId;

    if (!examId) {
      return res.json({ success: true, error: "Exam id not found" });
    }

    const intExamId = parseInt(examId);

    // 1. Validate the examId from the URL parameters
    if (isNaN(intExamId)) {
      return res.status(400).json({
        success: false,
        error: "A valid numeric Exam ID is required.",
      });
    }

    // 2. Fetch the profile from the database
    const profile = await prisma.userScheduleProfile.findUnique({
      where: {
        // Use the compound unique key to find the exact profile
        userId_examId: {
          userId: uid,
          examId: intExamId,
        },
      },
    });

    // 3. Handle the case where the user has not created a profile yet
    if (!profile) {
      return res.status(404).json({
        success: false,
        error:
          "Schedule profile not found for this user and exam. Please create one.",
      });
    }

    // 4. Send the successful response
    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error("Error fetching schedule profile:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};
