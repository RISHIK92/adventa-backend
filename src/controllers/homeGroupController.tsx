import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const publicGroupsQuerySchema = z.object({
  search: z.string().optional(),
  subjectId: z.coerce.number().int().optional(),
  examId: z.coerce.number().int().optional(),
  sortBy: z.enum(["score", "memberCount", "lastActivityAt"]).default("score"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/**
 * ROUTE: GET /api/groups/my-groups
 * Fetches all groups the authenticated user is a member or owner of.
 */
const getMyGroups = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;

    const groupMemberships = await prisma.studyRoomMember.findMany({
      where: { userId: uid },
      include: {
        studyRoom: {
          include: {
            _count: { select: { members: true } }, // Efficiently get member count
            subjects: { include: { subject: { select: { name: true } } } },
            exams: { include: { exam: { select: { name: true } } } },
          },
        },
      },
      orderBy: { studyRoom: { lastActivityAt: "desc" } },
    });

    // Process data to match frontend's expected format
    const myGroups = groupMemberships.map(({ role, studyRoom }) => {
      // Business logic to determine activity level
      const now = new Date();
      const lastActivity = new Date(studyRoom.lastActivityAt || now);
      const hoursSinceActivity =
        (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60);

      let activity: "high" | "medium" | "low" = "low";
      if (hoursSinceActivity < 24) activity = "high";
      else if (hoursSinceActivity < 72) activity = "medium";

      return {
        id: studyRoom.id,
        name: studyRoom.name,
        description: studyRoom.description,
        privacy: studyRoom.privacy,
        memberCount: studyRoom._count.members,
        // For UI, we can concatenate subjects or choose a primary one
        subjects: studyRoom.subjects.map((s) => s.subject.name),
        exams: studyRoom.exams.map((e) => e.exam.name),
        isOwner: role === "ADMIN",
        isMember: true,
        activity,
        lastActivityAt: studyRoom.lastActivityAt,
      };
    });

    res.json({ success: true, data: myGroups });
  } catch (error) {
    console.error("Error fetching user's groups:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/**
 * ROUTE: POST /api/groups
 * Creates a new group (study room).
 */
const createGroup = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;

    const { name, description, privacy, examIds, subjectIds, maxMembers } =
      req.body;

    if (!name || !privacy || !examIds || !subjectIds) {
      return res
        .status(400)
        .json({ success: false, error: "Missing required fields." });
    }

    const newGroup = await prisma.$transaction(async (tx) => {
      const group = await tx.studyRoom.create({
        data: {
          name,
          creator: { connect: { id: uid } },
          description,
          privacy,
          maxMembers,
          lastActivityAt: new Date(),
          admins: { connect: { id: uid } },
        },
      });

      // Add the creator as an ADMIN member and connect subjects/exams
      await Promise.all([
        tx.studyRoomMember.create({
          data: { studyRoomId: group.id, userId: uid, role: "ADMIN" },
        }),
        subjectIds && subjectIds.length > 0
          ? tx.studyRoomSubject.createMany({
              data: subjectIds.map((id: any) => ({
                studyRoomId: group.id,
                subjectId: id,
              })),
            })
          : Promise.resolve(),
        examIds && examIds.length > 0
          ? tx.studyRoomExam.createMany({
              data: examIds.map((id: any) => ({
                studyRoomId: group.id,
                examId: id,
              })),
            })
          : Promise.resolve(),
      ]);

      return group;
    });

    res.status(201).json({ success: true, data: newGroup });
  } catch (error) {
    console.error("Error creating group:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// ====================================================================
// CONTROLLER FOR: Group Invitations Panel
// ====================================================================

/**
 * ROUTE: GET /api/groups/invitations
 * Fetches all pending invitations for the authenticated user.
 */
const getGroupInvitations = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const invitations = await prisma.studyRoomInvitation.findMany({
      where: {
        inviteeId: uid,
        status: "PENDING",
      },
      include: {
        studyRoom: { select: { id: true, name: true } },
        inviter: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: invitations });
  } catch (error) {
    console.error("Error fetching invitations:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/**
 * ROUTE: POST /api/groups/invitations/:invitationId/respond
 * Handles accepting or declining a group invitation.
 */
const respondToInvitation = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { invitationId } = req.params;
    const { action } = req.body; // Expects 'accept' or 'decline'

    if (!invitationId || !action) {
      return res
        .status(400)
        .json({ success: false, error: "Missing required fields." });
    }

    if (action !== "accept" && action !== "decline") {
      return res.status(400).json({ success: false, error: "Invalid action." });
    }

    const invitation = await prisma.studyRoomInvitation.findFirst({
      where: { id: invitationId, inviteeId: uid, status: "PENDING" },
    });

    if (!invitation) {
      return res.status(404).json({
        success: false,
        error: "Invitation not found or already handled.",
      });
    }

    if (action === "accept") {
      await prisma.$transaction(async (tx) => {
        await tx.studyRoomMember.create({
          data: {
            studyRoomId: invitation.studyRoomId,
            userId: uid,
            role: "MEMBER",
          },
        });
        await tx.studyRoom.update({
          where: { id: invitation.studyRoomId },
          data: { memberCount: { increment: 1 } },
        });
        await tx.studyRoomInvitation.update({
          where: { id: invitationId },
          data: { status: "ACCEPTED" },
        });
      });
      res.json({ success: true, message: "Invitation accepted." });
    } else {
      // Decline
      await prisma.studyRoomInvitation.update({
        where: { id: invitationId },
        data: { status: "DECLINED" },
      });
      res.json({ success: true, message: "Invitation declined." });
    }
  } catch (error) {
    console.error("Error responding to invitation:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/**
 * ROUTE: GET /api/groups/public
 * Fetches, searches, and filters all public groups.
 */
const getPublicGroups = async (req: Request, res: Response) => {
  try {
    const validation = publicGroupsQuerySchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        errors: validation.error.flatten().fieldErrors,
      });
    }

    const { search, subjectId, examId, sortBy, page, limit } = validation.data;

    const where: Prisma.StudyRoomWhereInput = {
      privacy: "PUBLIC",
    };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }
    if (subjectId) {
      where.subjects = { some: { subjectId } };
    }
    if (examId) {
      where.exams = { some: { examId } };
    }

    const [groups, totalCount] = await Promise.all([
      prisma.studyRoom.findMany({
        where,
        include: {
          subjects: { include: { subject: { select: { name: true } } } },
        },
        orderBy: { [sortBy]: "desc" },
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.studyRoom.count({ where }),
    ]);

    res.json({
      success: true,
      data: groups,
      pagination: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching public groups:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/**
 * ROUTE: GET /api/groups/my-stats
 * Fetches quick statistics for the authenticated user's group activity.
 */
const getQuickStats = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;

    const [groupsJoined, groupsOwned, userGroupIds, reviewsCount] =
      await Promise.all([
        prisma.studyRoomMember.count({ where: { userId: uid } }),
        prisma.studyRoomMember.count({ where: { userId: uid, role: "ADMIN" } }),
        prisma.studyRoomMember.findMany({
          where: { userId: uid },
          select: { studyRoomId: true },
        }),
        prisma.studyRoomReview.count({ where: { userId: uid } }), // Example of another stat
      ]);

    const roomIds = userGroupIds.map((g) => g.studyRoomId);

    const memberAggregation =
      roomIds.length > 0
        ? await prisma.studyRoom.aggregate({
            where: { id: { in: roomIds } },
            _sum: { memberCount: true },
          })
        : { _sum: { memberCount: 0 } };

    const totalMemberReach = memberAggregation._sum.memberCount || 0;

    res.json({
      success: true,
      data: {
        groupsJoined,
        groupsOwned,
        totalMemberReach,
        reviewsCount,
      },
    });
  } catch (error) {
    console.error("Error fetching quick stats:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/**
 * ROUTE: GET /api/groups/recommendations
 * Fetches AI-powered group recommendations. (Placeholder)
 */
const getRecommendedGroups = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;

    const userSubjectPerformance = await prisma.userSubjectPerformance.findMany(
      {
        where: { userId: uid },
        orderBy: { accuracyPercent: "desc" },
        include: { subject: { select: { id: true, name: true } } },
      }
    );

    const baseWhereClause: Prisma.StudyRoomWhereInput = {
      privacy: "PUBLIC",
      NOT: {
        OR: [{ createdBy: uid }, { members: { some: { userId: uid } } }],
      },
    };

    let matchingGroups;

    if (userSubjectPerformance.length === 0) {
      matchingGroups = await prisma.studyRoom.findMany({
        where: baseWhereClause,
        orderBy: [{ score: "desc" }, { lastActivityAt: "desc" }],
        take: 5,
        include: { subjects: { include: { subject: true } } },
      });
    } else {
      const topSubjectIds = userSubjectPerformance
        .slice(0, 3)
        .map((p) => p.subjectId);

      const personalizedWhereClause: Prisma.StudyRoomWhereInput = {
        ...baseWhereClause,
        subjects: {
          some: {
            subjectId: { in: topSubjectIds },
          },
        },
      };

      matchingGroups = await prisma.studyRoom.findMany({
        where: personalizedWhereClause,
        take: 20,
        include: {
          subjects: { include: { subject: true } },
        },
      });
    }

    const rankedRecommendations = matchingGroups.map((group) => {
      const hoursSinceActivity = group.lastActivityAt
        ? (new Date().getTime() - new Date(group.lastActivityAt).getTime()) /
          (1000 * 60 * 60)
        : 24 * 30;
      const freshnessScore = Math.max(0, 1 - hoursSinceActivity / (24 * 7));
      const normalizedScore = (group.score?.toNumber() || 0) / 1000;
      const normalizedMembers = (group.memberCount || 0) / 500;

      const recommendationScore =
        freshnessScore * 0.5 + normalizedScore * 0.3 + normalizedMembers * 0.2;
      const { subjects, ...restOfGroup } = group;

      const subjectNames = subjects.map((s) => s.subject.name);

      return {
        ...restOfGroup,
        subjects: subjectNames,
        recommendationScore,
      };
    });

    rankedRecommendations.sort(
      (a, b) => b.recommendationScore - a.recommendationScore
    );

    res.json({ success: true, data: rankedRecommendations.slice(0, 5) });
  } catch (error) {
    console.error("Error fetching recommendations:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/**
 * ROUTE: POST /api/study-group/:studyRoomId/join
 * Allows an authenticated user to join a public study room.
 */
const joinPublicGroup = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res
        .status(400)
        .json({ success: false, error: "Study Room ID is required." });
    }

    // Start a transaction to ensure data integrity
    const result = await prisma.$transaction(async (tx) => {
      const studyRoom = await tx.studyRoom.findUnique({
        where: { id: studyRoomId },
        select: {
          privacy: true,
          maxMembers: true,
          _count: { select: { members: true } },
        },
      });

      // 1. Validation Checks
      if (!studyRoom) {
        throw new Error("Group not found.");
      }
      if (studyRoom.privacy !== "PUBLIC") {
        throw new Error(
          "This group is not public. Joining requires an invitation."
        );
      }
      if (
        studyRoom.maxMembers &&
        studyRoom._count.members >= studyRoom.maxMembers
      ) {
        throw new Error("This group is full.");
      }

      // 2. Check if user is already a member to prevent errors
      const existingMembership = await tx.studyRoomMember.findUnique({
        where: { studyRoomId_userId: { studyRoomId, userId: uid } },
      });

      if (existingMembership) {
        throw new Error("You are already a member of this group.");
      }

      // 3. Create the membership and update the group's member count
      await tx.studyRoomMember.create({
        data: {
          studyRoomId,
          userId: uid,
          role: "MEMBER", // Users joining public groups are members by default
        },
      });

      await tx.studyRoom.update({
        where: { id: studyRoomId },
        data: {
          memberCount: { increment: 1 },
          lastActivityAt: new Date(), // Joining is an activity
        },
      });

      return { success: true };
    });

    res
      .status(200)
      .json({ success: true, message: "Successfully joined the group." });
  } catch (error: any) {
    // Handle specific errors thrown from the transaction
    if (error.message === "Group not found.") {
      return res.status(404).json({ success: false, error: error.message });
    }
    if (
      error.message.includes("not public") ||
      error.message.includes("full") ||
      error.message.includes("already a member")
    ) {
      return res.status(403).json({ success: false, error: error.message });
    }

    console.error("Error joining public group:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: DELETE /api/study-group/:studyRoomId/leave
 * Allows an authenticated user to leave a group they are a member of.
 */
const leaveGroup = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res
        .status(400)
        .json({ success: false, error: "Study Room ID is required." });
    }

    await prisma.$transaction(async (tx) => {
      // 1. Find the user's membership in the group
      const membership = await tx.studyRoomMember.findUnique({
        where: { studyRoomId_userId: { studyRoomId, userId: uid } },
        include: {
          studyRoom: {
            select: {
              _count: { select: { members: { where: { role: "ADMIN" } } } },
            },
          },
        },
      });

      if (!membership) {
        throw new Error("You are not a member of this group.");
      }

      // 2. CRITICAL: Prevent the last admin from leaving the group
      const adminCount = membership.studyRoom._count.members;
      if (membership.role === "ADMIN" && adminCount <= 1) {
        throw new Error(
          "You are the last admin. Please delete the group or promote another member before leaving."
        );
      }

      await tx.studyRoomMember.delete({
        where: { studyRoomId_userId: { studyRoomId, userId: uid } },
      });

      await tx.studyRoom.update({
        where: { id: studyRoomId },
        data: {
          memberCount: { decrement: 1 },
          lastActivityAt: new Date(),
        },
      });
    });

    res
      .status(200)
      .json({ success: true, message: "You have left the group." });
  } catch (error: any) {
    if (
      error.message.includes("not a member") ||
      error.message.includes("last admin")
    ) {
      return res.status(403).json({ success: false, error: error.message });
    }
    console.error("Error leaving group:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

const deleteStudyRoom = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res.status(400).json({ error: "Room ID is required" });
    }
    const room = await prisma.studyRoom.findUnique({
      where: { id: studyRoomId },
      include: { admins: true },
    });

    if (!room) {
      return res.status(404).json({ error: "Study room not found" });
    }

    if (!room.admins.some((admin) => admin.id === uid)) {
      return res.status(403).json({ error: "Only admins can delete the room" });
    }

    await prisma.studyRoom.delete({
      where: { id: studyRoomId },
    });

    res.json({ success: true, message: "Study room deleted successfully" });
  } catch (error) {
    console.error("Error deleting study room:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export {
  getMyGroups,
  createGroup,
  getGroupInvitations,
  respondToInvitation,
  getPublicGroups,
  getQuickStats,
  getRecommendedGroups,
  joinPublicGroup,
  leaveGroup,
  deleteStudyRoom,
};
