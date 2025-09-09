import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import z from "zod";
import type { DifficultyLevel, UserTestAnswer } from "@prisma/client";
import { redisClient } from "../config/redis.js";
import {
  updateGlobalTopicAverages,
  updateGlobalSubtopicAverages,
  updateGlobalSubjectAverages,
  updateUserOverallAverage,
} from "../utils/globalStatsUpdater.js";
import { nanoid } from "nanoid";

const generateInviteLinkBodySchema = z.object({
  // Expiry in hours from now.
  expiresInHours: z.coerce.number().int().min(1).max(720).default(72),
});

const promoteAdminBodySchema = z.object({
  memberIdToPromote: z.string().nonempty({ message: "Member ID is required." }),
});

const createScheduledTestSchema = z
  .object({
    name: z.string().min(3, "Test name must be at least 3 characters long."),
    durationInMinutes: z.number().int().positive(),
    totalQuestions: z
      .number()
      .int()
      .min(1, "Test must have at least one question."),
    scheduledStartTime: z.coerce.date(),
    subjectIds: z
      .array(z.number().int())
      .min(1, "At least one subject must be selected."),
    difficultyDistribution: z.object({
      Easy: z.number().min(0).max(100),
      Medium: z.number().min(0).max(100),
      Hard: z.number().min(0).max(100),
    }),
  })
  .refine(
    (data) => {
      const total =
        data.difficultyDistribution.Easy +
        data.difficultyDistribution.Medium +
        data.difficultyDistribution.Hard;
      return Math.abs(total - 100) < 0.01;
    },
    {
      message: "Difficulty percentages must sum to 100.",
      path: ["difficultyDistribution"],
    }
  );

const getGroupDetails = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res.status(400).json({
        success: false,
        error: "Study room ID is required.",
      });
    }

    // 1. Authorization: Ensure the user is a member of the group
    const membership = await prisma.studyRoomMember.findUnique({
      where: { studyRoomId_userId: { studyRoomId, userId: uid } },
    });

    if (!membership) {
      return res
        .status(403)
        .json({ success: false, error: "You are not a member of this group." });
    }

    // 2. Fetch group details
    const group = await prisma.studyRoom.findUnique({
      where: { id: studyRoomId },
      include: {
        _count: { select: { members: true } },
        members: {
          take: 3,
          orderBy: { role: "asc" }, // Show admins first
          include: { user: { select: { fullName: true } } },
        },
        // Find the most recent, non-expired invite code
        inviteCodes: {
          where: { expiresAt: { gt: new Date() } },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!group) {
      return res
        .status(404)
        .json({ success: false, error: "Group not found." });
    }

    // 3. Format the response
    const inviteCode = group.inviteCodes[0]?.code;
    const inviteLink = inviteCode
      ? `https://studygroup.app/join/${group.name.replace(
          /\s+/g,
          "-"
        )}/${inviteCode}`
      : null;

    res.json({
      success: true,
      data: {
        name: group.name,
        privacy: group.privacy,
        memberCount: group._count.members,
        sampleMembers: group.members.map((m: any) => m.user.fullName),
        yourRole: membership.role, // Let the frontend know if the user is an admin
        inviteLink: inviteLink,
        inviteLinkExpiry: group.inviteCodes[0]?.expiresAt || null,
      },
    });
  } catch (error) {
    console.error("Error fetching group details:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};

/**
 * ROUTE: POST /api/study-group/:studyRoomId/generate-invite-link
 * Generates or regenerates a shareable invite link for a group.
 */
const generateInviteLink = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res.status(400).json({
        success: false,
        error: "Study room ID is required.",
      });
    }

    // 1. Validate request body
    const validation = generateInviteLinkBodySchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: validation.error.flatten().fieldErrors,
      });
    }
    const { expiresInHours } = validation.data;

    const newInvite = await prisma.$transaction(async (tx) => {
      // 2. Authorization: User must be an ADMIN
      const membership = await tx.studyRoomMember.findUnique({
        where: { studyRoomId_userId: { studyRoomId, userId: uid } },
      });
      if (membership?.role !== "ADMIN") {
        throw new Error("Only admins can generate invite links.");
      }

      // 3. Deactivate old links to ensure only one is active
      await tx.studyRoomInvite.updateMany({
        where: { studyRoomId },
        data: { expiresAt: new Date() }, // Set expiry to now
      });

      // 4. Create the new invite link
      const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
      const newCode = nanoid(12); // e.g., '2euhrfnjdjm'

      return tx.studyRoomInvite.create({
        data: {
          studyRoomId,
          code: newCode,
          expiresAt,
        },
      });
    });

    const studyRoom = await prisma.studyRoom.findUnique({
      where: { id: studyRoomId },
      select: { name: true },
    });
    const inviteLink = `https://studygroup.app/join/${studyRoom?.name.replace(
      /\s+/g,
      "-"
    )}/${newInvite.code}`;

    res.status(201).json({
      success: true,
      data: {
        inviteLink: inviteLink,
        expiresAt: newInvite.expiresAt,
      },
    });
  } catch (error: any) {
    if (error.message.includes("admins can generate")) {
      return res.status(403).json({ success: false, error: error.message });
    }
    console.error("Error generating invite link:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};

/**
 * ROUTE: POST /api/study-group/:studyRoomId/promote-admin
 * Promotes a member of a group to an admin role.
 */
const promoteToAdmin = async (req: Request, res: Response) => {
  try {
    const { uid: promoterId } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res.status(400).json({
        success: false,
        error: "Study room ID is required.",
      });
    }

    const validation = promoteAdminBodySchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: validation.error.flatten().fieldErrors,
      });
    }
    const { memberIdToPromote } = validation.data;

    await prisma.$transaction(async (tx) => {
      // 1. Fetch both memberships to perform checks
      const memberships = await tx.studyRoomMember.findMany({
        where: { studyRoomId, userId: { in: [promoterId, memberIdToPromote] } },
      });

      const promoter = memberships.find((m) => m.userId === promoterId);
      const memberToPromote = memberships.find(
        (m) => m.userId === memberIdToPromote
      );

      // 2. Authorization and Validation
      if (promoter?.role !== "ADMIN") {
        throw new Error("Only admins can promote other members.");
      }
      if (!memberToPromote) {
        throw new Error("Member not found in this group.");
      }
      if (memberToPromote.role === "ADMIN") {
        // Already an admin, no action needed.
        return;
      }

      // 3. Update the member's role
      await tx.studyRoomMember.update({
        where: {
          studyRoomId_userId: { studyRoomId, userId: memberIdToPromote },
        },
        data: { role: "ADMIN" },
      });
    });

    res.status(200).json({
      success: true,
      message: "Member successfully promoted to admin.",
    });
  } catch (error: any) {
    if (
      error.message.includes("Only admins") ||
      error.message.includes("Member not found")
    ) {
      return res.status(403).json({ success: false, error: error.message });
    }
    console.error("Error promoting to admin:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
};

/**
 * ROUTE: GET /api/study-group/:studyRoomId/members
 * Fetches a fully detailed list of all members for the GroupMembersPanel component.
 */
const getGroupMembers = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res
        .status(400)
        .json({ success: false, error: "Study room ID is required." });
    }

    // 1. Authorization: Verify the requester is a member of the group.
    const requesterMembership = await prisma.studyRoomMember.findUnique({
      where: { studyRoomId_userId: { studyRoomId, userId: uid } },
    });
    if (!requesterMembership) {
      return res
        .status(403)
        .json({ success: false, error: "You are not a member of this group." });
    }

    const groupSubjects = await prisma.studyRoomSubject.findMany({
      where: { studyRoomId },
      select: { subjectId: true },
    });
    const groupSubjectIds = groupSubjects.map((s) => s.subjectId);

    // 2. The Main Query: Fetch all members and their related stats in one go.
    const membersFromDb = await prisma.studyRoomMember.findMany({
      where: { studyRoomId },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            badges: {
              where: { studyRoomId },
              include: { badge: { select: { name: true } } },
            },
            memberStats: { where: { studyRoomId } },
            UserSubjectPerformance: {
              where: {
                subjectId: { in: groupSubjectIds },
              },
              include: { subject: { select: { name: true } } },
            },
            testInstances: {
              where: { completedAt: { not: null } },
              select: { score: true, totalMarks: true },
            },
          },
        },
      },
      orderBy: { user: { fullName: "asc" } },
    });

    const formattedMembers = membersFromDb.map((member) => {
      const { user } = member;

      const totalScore = user.testInstances.reduce(
        (sum, test) => sum + test.score,
        0
      );
      const totalMaxMarks = user.testInstances.reduce(
        (sum, test) => sum + test.totalMarks,
        0
      );
      const averageScore =
        totalMaxMarks > 0 ? Math.round((totalScore / totalMaxMarks) * 100) : 0;

      return {
        id: user.id,
        name: user.fullName,
        email: user.email,
        role: member.role.toLowerCase(),
        subjects: user.UserSubjectPerformance.map((sp) => ({
          name: sp.subject.name,
          strength: sp.accuracyPercent.toNumber(),
          weakness: 100 - sp.accuracyPercent.toNumber(),
        })),
        badges: user.badges.map((b) => b.badge.name),
        stats: {
          streak: user.memberStats[0]?.streak || 0,
          totalPoints: user.memberStats[0]?.totalPoints || 0,
          averageScore,
        },
      };
    });

    res.json({ success: true, data: formattedMembers });
  } catch (error) {
    console.error("Error fetching group members:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: GET /api/study-group/:studyRoomId/mock-test
 * Fetches subjects and members for creating a mock test.
 */
const getMockTest = async (req: Request, res: Response) => {
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
      return res.status(403).json({ success: false, error: "Access denied." });
    }

    const groupSubjects = await prisma.studyRoomSubject.findMany({
      where: { studyRoomId },
      select: { subject: { select: { id: true, name: true } } },
    });

    const groupMembers = await prisma.studyRoomMember.findMany({
      where: { studyRoomId },
      select: {
        user: {
          select: { id: true, fullName: true },
        },
      },
    });

    const subjects = groupSubjects.map((s) => s.subject);
    const members = groupMembers.map((m) => m.user);

    res.json({ success: true, data: { subjects, members } });
  } catch (error) {
    console.error("Error fetching mock test data:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: POST /api/study-group/:studyRoomId/schedule-test
 * Creates and schedules a new mock test for a group.
 */
const createScheduledGroupTest = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res
        .status(400)
        .json({ success: false, error: "Study room ID is required." });
    }

    // 1. Validate Input
    const validation = createScheduledTestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        errors: validation.error.flatten().fieldErrors,
      });
    }
    const {
      name,
      durationInMinutes,
      totalQuestions,
      scheduledStartTime,
      subjectIds,
      difficultyDistribution,
    } = validation.data;

    // 2. Authorization: Check if the user is a member of the group.
    const membership = await prisma.studyRoomMember.findUnique({
      where: { studyRoomId_userId: { studyRoomId, userId: uid } },
    });
    if (!membership) {
      return res.status(403).json({
        success: false,
        error: "You must be a member of the group to create a test.",
      });
    }

    // --- 3. Question Generation Logic ---

    // a. Distribute total questions among subjects, handling remainders with priority.
    const numSubjects = subjectIds.length;
    const baseQuestionsPerSubject = Math.floor(totalQuestions / numSubjects);
    let remainder = totalQuestions % numSubjects;
    const questionsPerSubjectMap = new Map<number, number>();
    subjectIds.forEach((id) =>
      questionsPerSubjectMap.set(id, baseQuestionsPerSubject)
    );

    const selectedSubjects = await prisma.subject.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true, name: true },
    });
    const mathSubject = selectedSubjects.find(
      (s) => s.name.toLowerCase() === "mathematics"
    );
    const bioSubject = selectedSubjects.find(
      (s) => s.name.toLowerCase() === "biology"
    );

    if (remainder > 0 && mathSubject) {
      questionsPerSubjectMap.set(
        mathSubject.id,
        questionsPerSubjectMap.get(mathSubject.id)! + 1
      );
      remainder--;
    }
    if (remainder > 0 && bioSubject) {
      questionsPerSubjectMap.set(
        bioSubject.id,
        questionsPerSubjectMap.get(bioSubject.id)! + 1
      );
      remainder--;
    }
    let subjectIndex = 0;
    while (remainder > 0) {
      const subjectId = subjectIds[subjectIndex % numSubjects];
      if (subjectId !== mathSubject?.id && subjectId !== bioSubject?.id) {
        if (!subjectId) {
          return;
        }
        questionsPerSubjectMap.set(
          subjectId,
          questionsPerSubjectMap.get(subjectId)! + 1
        );
        remainder--;
      }
      subjectIndex++;
    }

    // --- 4. Database Transaction ---
    await prisma.$transaction(async (tx) => {
      // b. For each subject, fetch random question IDs based on difficulty distribution.
      const subjectQuestionPromises = subjectIds.map(async (subjectId) => {
        const totalForSubject = questionsPerSubjectMap.get(subjectId)!;
        const questionsForDifficulty = {
          Easy: Math.round(
            totalForSubject * (difficultyDistribution.Easy / 100)
          ),
          Medium: Math.round(
            totalForSubject * (difficultyDistribution.Medium / 100)
          ),
          Hard: 0,
        };
        questionsForDifficulty.Hard =
          totalForSubject -
          (questionsForDifficulty.Easy + questionsForDifficulty.Medium);

        const fetchedIds: number[] = [];
        for (const [difficulty, count] of Object.entries(
          questionsForDifficulty
        )) {
          if (count > 0) {
            // NOTE: Using raw query for random fetching as Prisma `orderBy` can be slow.
            // Ensure your database user has the necessary permissions.
            const questions = await tx.question.findMany({
              where: {
                subtopic: { topic: { subjectId } },
                humanDifficultyLevel: difficulty as DifficultyLevel,
              },
              take: count,
              select: { id: true },
              // orderBy: { id: 'asc' } // A simple order for deterministic tests, or use a random function if supported by your DB
            });
            fetchedIds.push(...questions.map((q) => q.id));
          }
        }
        return { subjectId, questionIds: fetchedIds };
      });

      const subjectQuestionSets = await Promise.all(subjectQuestionPromises);

      // c. Order the final question list subject-by-subject.
      const finalQuestionIds: number[] = [];
      for (const subjectId of subjectIds) {
        const set = subjectQuestionSets.find((s) => s.subjectId === subjectId);
        if (set) {
          finalQuestionIds.push(...set.questionIds);
        }
      }

      // d. Create the single parent "event" record.
      const scheduledTest = await tx.scheduledGroupTest.create({
        data: {
          name,
          studyRoomId,
          createdById: uid,
          durationInMinutes,
          totalQuestions,
          scheduledStartTime,
          difficultyDistribution,
          generatedQuestionIds: finalQuestionIds,
          subjects: {
            create: subjectIds.map((subjectId) => ({ subjectId })),
          },
        },
      });

      // e. Get all members of the study group to create their test instances.
      const members = await tx.studyRoomMember.findMany({
        where: { studyRoomId },
        select: { userId: true },
      });
      if (members.length === 0) return;

      // f. Prepare the data for each user's individual test instance.
      const testInstancesData = members.map((member) => ({
        userId: member.userId,
        testName: name,
        testType: "group" as const,
        score: 0,
        totalMarks: totalQuestions * 4, // Standard scoring: +4 for correct
        totalQuestions: totalQuestions,
        numCorrect: 0,
        numIncorrect: 0,
        numUnattempted: totalQuestions,
        timeTakenSec: 0,
        scheduledGroupTestId: scheduledTest.id, // Link back to the parent event
      }));

      // g. Create all user test instances in a single batch operation.
      await tx.userTestInstanceSummary.createMany({
        data: testInstancesData,
      });
    });

    res.status(201).json({
      success: true,
      message: "Group mock test scheduled successfully for all members.",
    });
  } catch (error) {
    console.error("Error creating scheduled group test:", error);
    if (error instanceof z.ZodError) {
      return res
        .status(400)
        .json({ success: false, errors: error.flatten().fieldErrors });
    }
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

const getScheduledGroupTests = async (req: Request, res: Response) => {
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
    });
    if (!membership) {
      return res
        .status(403)
        .json({ success: false, error: "You are not a member of this group." });
    }

    // 2. Fetch all test events for the group
    const tests = await prisma.scheduledGroupTest.findMany({
      where: { studyRoomId },
      include: {
        subjects: {
          include: {
            subject: { select: { name: true } },
          },
        },
        // Efficiently get the total number of participants
        _count: {
          select: { testInstances: true },
        },
        // Specifically check if an instance exists for the CURRENT user that is completed
        testInstances: {
          where: {
            userId: uid,
            completedAt: { not: null },
          },
          select: { id: true }, // Select only ID for existence check
        },
      },
      orderBy: { scheduledStartTime: "desc" },
    });

    // 3. Format the data for the frontend
    const formattedTests = tests.map((test) => {
      const { subjects, _count, testInstances, ...restOfTest } = test;
      return {
        ...restOfTest,
        subjects: subjects.map((s) => s.subject.name),
        participantCount: _count.testInstances,
        // The user has completed the test if our specific query found an instance
        isCompletedByUser: testInstances.length > 0,
      };
    });

    res.json({ success: true, data: formattedTests });
  } catch (error) {
    console.error("Error fetching scheduled tests:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

const startGroupTest = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { scheduledTestId } = req.params;

    if (!scheduledTestId) {
      return res
        .status(400)
        .json({ success: false, error: "Scheduled Test ID is required." });
    }
    console.log(scheduledTestId);

    // 1. Find the specific test instance for this user and this event
    const testInstance = await prisma.userTestInstanceSummary.findFirst({
      where: {
        scheduledGroupTestId: scheduledTestId,
        userId: uid,
      },
      select: { id: true, completedAt: true },
    });

    console.log(testInstance);

    // 2. Handle case where no instance exists (e.g., user joined group after test was scheduled)
    if (!testInstance) {
      return res.status(404).json({
        success: false,
        error:
          "Your test instance for this event could not be found. Please contact the group admin.",
      });
    }

    // 4. Return the unique ID for the user's attempt
    res.json({ success: true, data: { testInstanceId: testInstance.id } });
  } catch (error) {
    console.error("Error starting group test:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

const getGroupMembersForSelection = async (req: Request, res: Response) => {
  try {
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res
        .status(400)
        .json({ success: false, error: "Study room ID is required." });
    }

    const members = await prisma.studyRoomMember.findMany({
      where: { studyRoomId },
      select: {
        user: {
          select: { id: true, fullName: true },
        },
      },
    });
    const memberList = members.map((m) => m.user);
    res.json({ success: true, data: memberList });
  } catch (error) {
    console.error("Error fetching members for selection:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/**
 * ROUTE: GET /api/scheduled-group-test/:testId
 * Fetches details for a single scheduled test, including its questions.
 * This is a protected route for test participants only.
 */
const getGroupTestInstanceDetails = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    if (!testInstanceId) {
      return res
        .status(400)
        .json({ success: false, error: "Test Instance ID is required." });
    }

    // 1. Authorize and fetch the instance with its parent event details
    const testInstance = await prisma.userTestInstanceSummary.findUnique({
      where: {
        id: testInstanceId,
        userId: uid, // Ensures a user can only access their own test
      },
      include: {
        scheduledGroupTest: true, // Include the parent event to get questions and timing
      },
    });

    // 2. Handle errors if the instance is not found or is malformed
    if (!testInstance || !testInstance.scheduledGroupTest) {
      return res.status(404).json({
        success: false,
        error: "Group test instance not found for this user.",
      });
    }
    if (testInstance.completedAt) {
      return res.status(403).json({
        success: false,
        error: "This test has already been completed.",
      });
    }

    const scheduledTest = testInstance.scheduledGroupTest;

    // 3. Fetch time already spent from Redis
    const redisKey = `progress:${testInstanceId}`;
    const timeSpentString = await redisClient.hGet(redisKey, "_totalTime");
    const timeSpentSec = parseInt(timeSpentString || "0", 10);

    // 4. Calculate the dynamic time limit for the user
    const currentTime = new Date();
    const scheduledStartTime = new Date(scheduledTest.scheduledStartTime);
    const officialEndTime = new Date(
      scheduledStartTime.getTime() + scheduledTest.durationInMinutes * 60 * 1000
    );
    if (currentTime >= officialEndTime) {
      return res.status(403).json({
        success: false,
        error: "This test has already officially ended.",
      });
    }

    const remainingSecondsUntilEnd =
      (officialEndTime.getTime() - currentTime.getTime()) / 1000;
    // The final time is what's left until the end, minus time already spent
    const finalTimeLimit = remainingSecondsUntilEnd - timeSpentSec;
    const totalDurationSeconds = scheduledTest.durationInMinutes * 60;
    const timeLimit = Math.min(
      totalDurationSeconds,
      Math.max(0, Math.floor(finalTimeLimit))
    );

    // 5. Fetch and format questions exactly as the frontend expects
    const questionIds = scheduledTest.generatedQuestionIds as number[];

    if (!Array.isArray(questionIds) || questionIds.length === 0) {
      return res.json({ success: true, data: { timeLimit, questions: [] } });
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

    // 6. Send the final, formatted response
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
    console.error("Error fetching group test instance details:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: POST /api/scheduled-group-test/:testInstanceId/submit
 * Finalizes a test by processing Redis data, calculating scores,
 * and persisting the results to the main database.
 */
const submitScheduledTest = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    if (!testInstanceId) {
      return res
        .status(400)
        .json({ success: false, error: "Test Instance ID is required." });
    }

    // --- PHASE 1: VALIDATION & DATA FETCHING ---
    const testInstance = await prisma.userTestInstanceSummary.findUnique({
      where: { id: testInstanceId, userId: uid },
      include: {
        scheduledGroupTest: {
          select: { generatedQuestionIds: true },
        },
      },
    });

    if (!testInstance) {
      return res.status(404).json({
        success: false,
        error: "Test instance not found for this user.",
      });
    }
    if (testInstance.completedAt) {
      return res.status(403).json({
        success: false,
        error: "This test has already been submitted.",
      });
    }

    const redisKey = `progress:${testInstanceId}`;
    const [savedProgress, questionIds] = await Promise.all([
      redisClient.hGetAll(redisKey),
      (testInstance.scheduledGroupTest?.generatedQuestionIds as number[]) || [],
    ]);

    if (!Array.isArray(questionIds) || questionIds.length === 0) {
      return res.status(500).json({
        success: false,
        error: "Could not determine the question set for this test.",
      });
    }

    const questions = await prisma.question.findMany({
      where: { id: { in: questionIds } },
      include: {
        subtopic: { include: { topic: { include: { subject: true } } } },
      },
    });
    const questionsMap = new Map(questions.map((q) => [q.id, q]));

    // --- PHASE 2: PROCESS REDIS DATA & CALCULATE SCORE ---
    let numCorrect = 0;
    const userAnswersToSave: any = [];
    const totalTimeTakenSec = parseInt(savedProgress._totalTime || "0", 10);
    delete savedProgress._totalTime;

    const topicUpdates = new Map<
      number,
      { attempted: number; correct: number; time: number }
    >();
    const subtopicUpdates = new Map<
      number,
      { attempted: number; correct: number; time: number }
    >();
    const topicDifficultyUpdates = new Map<
      string,
      { attempted: number; correct: number; time: number }
    >();

    const uniqueTopicIds = new Set<number>();
    const uniqueSubtopicIds = new Set<number>();
    const uniqueSubjectIds = new Set<number>();

    for (const questionIdStr of Object.keys(savedProgress)) {
      const progressString = savedProgress[questionIdStr];
      if (typeof progressString !== "string") continue;

      const questionId = parseInt(questionIdStr, 10);
      const questionData = questionsMap.get(questionId);
      if (!questionData) continue;

      const progress = JSON.parse(progressString);
      const isCorrect =
        progress.answer != null &&
        String(progress.answer) === String(questionData.correctOption);
      if (isCorrect) numCorrect++;

      const status = progress.answer
        ? isCorrect
          ? "Correct"
          : "Incorrect"
        : "Unattempted";

      userAnswersToSave.push({
        testInstanceId,
        userId: uid,
        questionId,
        userAnswer: progress.answer,
        isCorrect,
        status,
        timeTakenSec: Math.round(progress.time || 0),
      });

      // Aggregate performance data if the question was attempted
      if (status !== "Unattempted") {
        const { subtopic } = questionData;
        const { topic } = subtopic;
        const { subject } = topic;
        const difficulty = questionData.humanDifficultyLevel;

        const updateMap = (map: Map<any, any>, key: any, time: number) => {
          const update = map.get(key) || { attempted: 0, correct: 0, time: 0 };
          update.attempted++;
          update.correct += isCorrect ? 1 : 0;
          update.time += time;
          map.set(key, update);
        };

        uniqueTopicIds.add(topic.id);
        uniqueSubtopicIds.add(subtopic.id);
        uniqueSubjectIds.add(subject.id);

        updateMap(topicUpdates, topic.id, Math.round(progress.time || 0));
        updateMap(subtopicUpdates, subtopic.id, Math.round(progress.time || 0));
        updateMap(
          topicDifficultyUpdates,
          `${topic.id}-${difficulty}`,
          Math.round(progress.time || 0)
        );
      }
    }

    const numAttempted = userAnswersToSave.filter(
      (a: any) => a.status !== "Unattempted"
    ).length;
    const numIncorrect = numAttempted - numCorrect;
    const numUnattempted = testInstance.totalQuestions - numAttempted;
    const finalScore = numCorrect * 4 + numIncorrect * -1;

    // --- PHASE 3: DATABASE TRANSACTION ---
    await prisma.$transaction(async (tx) => {
      // 1. Save all the answers from this test
      if (userAnswersToSave.length > 0) {
        await tx.userTestAnswer.createMany({ data: userAnswersToSave });
      }

      // 2. Update the main test instance summary
      await tx.userTestInstanceSummary.update({
        where: { id: testInstanceId },
        data: {
          completedAt: new Date(),
          score: finalScore,
          numCorrect,
          numIncorrect,
          numUnattempted,
          timeTakenSec: totalTimeTakenSec,
        },
      });

      // 3. Upsert performance records for every affected topic, subtopic, etc.
      for (const [topicId, update] of topicUpdates.entries()) {
        const currentPerf = await tx.userTopicPerformance.findUnique({
          where: { userId_topicId: { userId: uid, topicId } },
        });
        const newTotalAttempted =
          (currentPerf?.totalAttempted || 0) + update.attempted;
        const newTotalCorrect =
          (currentPerf?.totalCorrect || 0) + update.correct;
        const newTotalTime =
          (currentPerf?.totalTimeTakenSec || 0) + update.time;
        await tx.userTopicPerformance.upsert({
          where: { userId_topicId: { userId: uid, topicId } },
          create: {
            userId: uid,
            topicId,
            totalAttempted: update.attempted,
            totalCorrect: update.correct,
            totalTimeTakenSec: update.time,
            accuracyPercent: (update.correct / update.attempted) * 100,
            avgTimePerQuestionSec: update.time / update.attempted,
          },
          update: {
            totalAttempted: { increment: update.attempted },
            totalCorrect: { increment: update.correct },
            totalTimeTakenSec: { increment: update.time },
            accuracyPercent: (newTotalCorrect / newTotalAttempted) * 100,
            avgTimePerQuestionSec: newTotalTime / newTotalAttempted,
          },
        });
      }

      for (const [subtopicId, update] of subtopicUpdates.entries()) {
        const currentPerf = await tx.userSubtopicPerformance.findUnique({
          where: { userId_subtopicId: { userId: uid, subtopicId } },
        });
        const newTotalAttempted =
          (currentPerf?.totalAttempted || 0) + update.attempted;
        const newTotalCorrect =
          (currentPerf?.totalCorrect || 0) + update.correct;
        const newTotalTime =
          (currentPerf?.totalTimeTakenSec || 0) + update.time;
        await tx.userSubtopicPerformance.upsert({
          where: { userId_subtopicId: { userId: uid, subtopicId } },
          create: {
            userId: uid,
            subtopicId,
            totalAttempted: update.attempted,
            totalCorrect: update.correct,
            totalTimeTakenSec: update.time,
            accuracyPercent: (update.correct / update.attempted) * 100,
            avgTimePerQuestionSec: update.time / update.attempted,
          },
          update: {
            totalAttempted: { increment: update.attempted },
            totalCorrect: { increment: update.correct },
            totalTimeTakenSec: { increment: update.time },
            accuracyPercent: (newTotalCorrect / newTotalAttempted) * 100,
            avgTimePerQuestionSec: newTotalTime / newTotalAttempted,
          },
        });
      }

      for (const [key, update] of topicDifficultyUpdates.entries()) {
        const [topicIdStr, difficulty] = key.split("-");
        if (!topicIdStr || !difficulty) continue;
        const topicId = parseInt(topicIdStr);
        const currentPerf = await tx.userTopicDifficultyPerformance.findUnique({
          where: {
            userId_topicId_difficultyLevel: {
              userId: uid,
              topicId,
              difficultyLevel: difficulty as DifficultyLevel,
            },
          },
        });
        const newTotalAttempted =
          (currentPerf?.totalAttempted || 0) + update.attempted;
        const newTotalCorrect =
          (currentPerf?.totalCorrect || 0) + update.correct;
        const newTotalTime =
          (currentPerf?.totalTimeTakenSec || 0) + update.time;
        await tx.userTopicDifficultyPerformance.upsert({
          where: {
            userId_topicId_difficultyLevel: {
              userId: uid,
              topicId,
              difficultyLevel: difficulty as DifficultyLevel,
            },
          },
          create: {
            userId: uid,
            topicId,
            difficultyLevel: difficulty as DifficultyLevel,
            totalAttempted: update.attempted,
            totalCorrect: update.correct,
            totalTimeTakenSec: update.time,
            accuracyPercent: (update.correct / update.attempted) * 100,
            avgTimePerQuestionSec: update.time / update.attempted,
          },
          update: {
            totalAttempted: { increment: update.attempted },
            totalCorrect: { increment: update.correct },
            totalTimeTakenSec: { increment: update.time },
            accuracyPercent: (newTotalCorrect / newTotalAttempted) * 100,
            avgTimePerQuestionSec: newTotalTime / newTotalAttempted,
          },
        });
      }
    });

    // --- PHASE 4: CLEANUP & RESPONSE ---
    await redisClient.del(redisKey);

    const topicIds = [...uniqueTopicIds];
    const subtopicIds = [...uniqueSubtopicIds];
    const subjectIds = [...uniqueSubjectIds];

    updateGlobalTopicAverages(topicIds).catch((err) =>
      console.error("BG task failed: updateGlobalTopicAverages", err)
    );
    updateGlobalSubtopicAverages(subtopicIds).catch((err) =>
      console.error("BG task failed: updateGlobalSubtopicAverages", err)
    );
    updateGlobalSubjectAverages(subjectIds).catch((err) =>
      console.error("BG task failed: updateGlobalSubjectAverages", err)
    );
    updateUserOverallAverage(uid).catch((err) =>
      console.error("BG task failed: updateUserOverallAverage", err)
    );

    res.json({
      success: true,
      message: "Test submitted successfully.",
      data: {
        testInstanceId,
        score: finalScore,
        totalMarks: testInstance.totalMarks,
      },
    });
  } catch (error) {
    console.error("Error submitting test:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: GET /api/group-test-results/:scheduledTestId
 * Gathers and processes all data for the comprehensive group test results page,
 * including personal insights, group comparisons, a leaderboard, and detailed question review.
 */
/**
 * ROUTE: GET /api/group-test-results/:testInstanceId
 * Gathers and processes all data for the comprehensive group test results page.
 * It now uses the testInstanceId to find the relevant scheduledTestId.
 */
const getGroupMockTestResults = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { testInstanceId } = req.params;

    if (!testInstanceId) {
      return res
        .status(400)
        .json({ success: false, error: "Test Instance ID is required." });
    }

    // 1. Authorization & Fetching the Scheduled Test ID from the Instance ID
    const currentUserInstance = await prisma.userTestInstanceSummary.findFirst({
      where: {
        id: testInstanceId,
        userId: uid, // Ensures the user requesting is the one who took the test
        completedAt: { not: null },
      },
      select: {
        scheduledGroupTestId: true,
        // Also select fields needed later to avoid a second query for this user
        userId: true,
        score: true,
        numCorrect: true,
        numIncorrect: true,
        timeTakenSec: true,
        user: { select: { id: true, fullName: true } },
        answers: {
          include: {
            question: {
              include: {
                subtopic: {
                  include: { topic: { include: { subject: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (!currentUserInstance || !currentUserInstance.scheduledGroupTestId) {
      return res.status(404).json({
        success: false,
        error:
          "Your test result was not found or is incomplete. Please complete the test first.",
      });
    }

    const scheduledTestId = currentUserInstance.scheduledGroupTestId;

    // 2. Fetch Core Test Data
    const scheduledTest = await prisma.scheduledGroupTest.findUnique({
      where: { id: scheduledTestId },
    });

    if (!scheduledTest) {
      return res
        .status(404)
        .json({ success: false, error: "Scheduled test not found." });
    }

    // 3. Fetch ALL completed test instances for the group
    const allTestInstances = await prisma.userTestInstanceSummary.findMany({
      where: {
        scheduledGroupTestId: scheduledTestId,
        completedAt: { not: null },
      },
      include: {
        user: { select: { id: true, fullName: true } },
        answers: {
          include: {
            question: {
              include: {
                subtopic: {
                  include: { topic: { include: { subject: true } } },
                },
              },
            },
          },
        },
      },
      orderBy: { score: "desc" },
    });

    if (allTestInstances.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No completed results found for this test yet.",
      });
    }

    // 4. Calculate Leaderboard & High-Level Stats
    const totalParticipants = allTestInstances.length;
    const groupAverageScore =
      allTestInstances.reduce((sum, inst) => sum + inst.score, 0) /
      totalParticipants;
    const highestScoringInstance = allTestInstances[0];
    const lowestScore = Math.min(...allTestInstances.map((inst) => inst.score));

    const fastestSolver = [...allTestInstances].sort(
      (a, b) => a.timeTakenSec - b.timeTakenSec
    )[0];
    const mostAccurate = [...allTestInstances].sort((a, b) => {
      const accuracyA =
        a.numCorrect + a.numIncorrect > 0
          ? a.numCorrect / (a.numCorrect + a.numIncorrect)
          : 0;
      const accuracyB =
        b.numCorrect + b.numIncorrect > 0
          ? b.numCorrect / (b.numCorrect + b.numIncorrect)
          : 0;
      return accuracyB - accuracyA;
    })[0];

    if (!fastestSolver || !mostAccurate || !highestScoringInstance) {
      return res.status(500).json({
        success: false,
        error: "Error calculating performance badges.",
      });
    }

    const performanceBadges = {
      topScorer: highestScoringInstance.user.fullName || "N/A",
      fastestSolver: fastestSolver.user.fullName || "N/A",
      mostAccurate: mostAccurate.user.fullName || "N/A",
    };

    const leaderboard = allTestInstances.map((inst, index) => {
      const accuracy =
        inst.numCorrect + inst.numIncorrect > 0
          ? (inst.numCorrect / (inst.numCorrect + inst.numIncorrect)) * 100
          : 0;
      return {
        id: inst.userId,
        name: inst.user.fullName || "Anonymous User",
        score: inst.score,
        accuracy: Math.round(accuracy),
        timeTaken: inst.timeTakenSec,
        rank: index + 1,
      };
    });

    const currentUserAccuracy =
      currentUserInstance.numCorrect + currentUserInstance.numIncorrect > 0
        ? (currentUserInstance.numCorrect /
            (currentUserInstance.numCorrect +
              currentUserInstance.numIncorrect)) *
          100
        : 0;

    const testResult = {
      id: scheduledTest.id,
      name: scheduledTest.name,
      date: scheduledTest.scheduledStartTime.toISOString(),
      duration: scheduledTest.durationInMinutes * 60,
      totalQuestions: scheduledTest.totalQuestions,
      myScore: currentUserInstance.score,
      groupAverage: Math.round(groupAverageScore),
      highestScore: highestScoringInstance.score,
      accuracy: Math.round(currentUserAccuracy),
      timeTaken: currentUserInstance.timeTakenSec,
      rank: leaderboard.find((u) => u.id === uid)?.rank || 0,
      totalParticipants: totalParticipants,
    };

    // 5. Perform Deep Hierarchical Analysis
    const { memberPerformances, groupPerformance } =
      _calculateHierarchicalAnalysis(allTestInstances);

    // 6. Process Detailed Question Review
    const allAnswersFlat = allTestInstances.flatMap((inst) => inst.answers);
    const questionReview = _formatQuestionReview(
      scheduledTest.generatedQuestionIds as number[],
      allAnswersFlat,
      uid
    );

    res.json({
      success: true,
      data: {
        testResult,
        leaderboard,
        hierarchicalData: memberPerformances[uid] || { subjects: {} },
        memberHierarchicalData: memberPerformances,
        groupAverageData: groupPerformance,
        questionReview,
        aiInsights: [],
        lowestScore,
        performanceBadges,
      },
    });
  } catch (error) {
    console.error("Error fetching group mock test results:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};
// Replace your entire _calculateHierarchicalAnalysis function with this one.

function _calculateHierarchicalAnalysis(allTestInstances: any[]) {
  const memberPerformances: Record<string, any> = {};
  const groupPerformance: any = { subjects: {} };

  // This part remains the same: it aggregates the raw data.
  allTestInstances.forEach((inst) => {
    memberPerformances[inst.userId] = { subjects: {} };
  });

  const allAnswers = allTestInstances.flatMap((inst) => inst.answers);

  for (const answer of allAnswers) {
    if (!answer.question?.subtopic?.topic?.subject) continue;
    const { question, userId, isCorrect, timeTakenSec, status } = answer;
    const { subtopic } = question;
    const { topic } = subtopic;
    const { subject } = topic;
    const difficulty = question.humanDifficultyLevel;

    const ensurePath = (obj: any, path: string[]) => {
      let current = obj;
      for (const key of path) {
        current[key] = current[key] || {};
        current = current[key];
      }
      return current;
    };

    const updateNode = (node: any) => {
      node.totalQuestions = (node.totalQuestions || 0) + 1;
      if (status !== "Unattempted") {
        node.attempted = (node.attempted || 0) + 1;
        node.time = (node.time || 0) + timeTakenSec;
        if (isCorrect) {
          node.correct = (node.correct || 0) + 1;
        }
      }
    };

    const subjectPath = ["subjects", subject.name];
    const topicPath = [...subjectPath, "topics", topic.name];
    const subtopicPath = [...topicPath, "subtopics", subtopic.name];
    const difficultyPath = [...subtopicPath, "difficulties", difficulty];

    [memberPerformances[userId], groupPerformance].forEach((perf) => {
      updateNode(ensurePath(perf, subjectPath));
      updateNode(ensurePath(perf, topicPath));
      updateNode(ensurePath(perf, subtopicPath));
      updateNode(ensurePath(perf, difficultyPath));
    });
  }

  // --- CHANGE: This is the new, corrected finalization logic ---
  const finalizeStats = (node: any) => {
    if (!node) return;

    // These are the possible children keys for any given node.
    const childKeys = ["subjects", "topics", "subtopics", "difficulties"];

    // 1. Recurse down to the deepest children first (post-order traversal).
    childKeys.forEach((key) => {
      if (node[key]) {
        Object.values(node[key]).forEach((child) =>
          finalizeStats(child as any)
        );
      }
    });

    // 2. Now that children are processed, calculate stats for the CURRENT node.
    // This check prevents adding stats to the root object which has no attempt data.
    if (node.hasOwnProperty("totalQuestions")) {
      const accuracy =
        node.attempted > 0 ? ((node.correct || 0) / node.attempted) * 100 : 0;

      node.accuracy = Math.round(accuracy);
      node.avgTimeSec =
        node.attempted > 0 ? (node.time || 0) / node.attempted : 0;

      // Ensure 'correct' key always exists for frontend consistency, even if it's 0.
      node.correct = node.correct || 0;
    }
  };

  // 3. Kick off the recursion from the top-level object for each member and the group.
  Object.values(memberPerformances).forEach(finalizeStats);
  finalizeStats(groupPerformance);

  return { memberPerformances, groupPerformance };
}

function _formatQuestionReview(
  questionIds: number[],
  allAnswers: any[],
  currentUserId: string
) {
  const questionsMap = new Map<number, any[]>();
  allAnswers.forEach((a) => {
    if (!questionsMap.has(a.questionId)) questionsMap.set(a.questionId, []);
    questionsMap.get(a.questionId)!.push(a);
  });

  return questionIds
    .map((qId) => {
      const answersForQ = questionsMap.get(qId) || [];
      if (answersForQ.length === 0) return null;

      const question = answersForQ[0].question;
      const currentUserAnswer = answersForQ.find(
        (a) => a.userId === currentUserId
      );

      const groupAttempted = answersForQ.filter(
        (a) => a.status !== "Unattempted"
      ).length;
      const groupCorrect = answersForQ.filter((a) => a.isCorrect).length;
      const rawAccuracy =
        groupAttempted > 0 ? (groupCorrect / groupAttempted) * 100 : 0;
      const groupAverageTime =
        groupAttempted > 0
          ? answersForQ.reduce((sum, a) => sum + a.timeTakenSec, 0) /
            groupAttempted
          : 0;

      const optionDistribution: Record<string, number> = {};
      const options = question.options as any;
      if (options && typeof options === "object") {
        Object.keys(options).forEach((optKey) => {
          optionDistribution[optKey] = answersForQ.filter(
            (a) => a.userAnswer === optKey
          ).length;
        });
      }

      return {
        id: question.id,
        text: question.question,
        subject: question.subtopic.topic.subject.name,
        topic: question.subtopic.topic.name,
        difficulty: question.humanDifficultyLevel,
        options: question.options,
        correctAnswer: question.correctOption,
        explanation: question.solution,
        myAnswer: currentUserAnswer?.userAnswer ?? null,
        timeTaken: currentUserAnswer?.timeTakenSec || 0,
        groupStats: {
          optionDistribution,
          averageTime: groupAverageTime,
          accuracy: Math.round(rawAccuracy), // --- CHANGE: Round accuracy
        },
        memberAnswers: Object.fromEntries(
          answersForQ.map((a) => [a.userId, a.userAnswer])
        ),
      };
    })
    .filter((q): q is NonNullable<typeof q> => q !== null);
}

export {
  getGroupDetails,
  generateInviteLink,
  promoteToAdmin,
  getGroupMembers,
  getMockTest,
  createScheduledGroupTest,
  startGroupTest,
  getScheduledGroupTests,
  getGroupMembersForSelection,
  getGroupTestInstanceDetails,
  submitScheduledTest,
  getGroupMockTestResults,
};
