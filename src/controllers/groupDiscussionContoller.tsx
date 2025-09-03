import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import z from "zod";

// --- Zod Schemas for Validation ---
const createThreadSchema = z.object({
  title: z.string().min(5, "Title must be at least 5 characters long."),
  content: z.string().min(10, "Content must be at least 10 characters long."),
  questionId: z.number().int().positive().optional(),
});

const createReplySchema = z.object({
  content: z.string().min(1, "Reply content cannot be empty."),
  parentId: z.string().uuid().optional(), // For nested replies
});

/**
 * ROUTE: GET /api/study-group/:studyRoomId/discussions
 * Fetches all discussion threads for a given study group.
 */
const getThreads = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!studyRoomId) {
      return res
        .status(400)
        .json({ success: false, error: "Study room ID is required." });
    }

    // Authorization: Verify user is a member of the group
    const membership = await prisma.studyRoomMember.findUnique({
      where: { studyRoomId_userId: { studyRoomId, userId: uid } },
    });
    if (!membership) {
      return res
        .status(403)
        .json({ success: false, error: "You are not a member of this group." });
    }

    const threads = await prisma.discussionThread.findMany({
      where: { studyRoomId },
      include: {
        author: {
          select: {
            id: true,
            fullName: true,
            badges: { include: { badge: true } },
          },
        },
        _count: {
          select: { replies: true, likes: true }, // Count likes on the thread itself
        },
        // Check if the current user has liked this thread
        likes: {
          where: { userId: uid },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const formattedThreads = threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      content: thread.content,
      author: {
        id: thread.author.id,
        name: thread.author.fullName || "Anonymous",
        // You would calculate reputation based on likes, replies, etc.
        reputation: thread._count.likes * 5 + thread._count.replies * 2,
        badges: thread.author.badges.map((b) => b.badge.name),
      },
      timestamp: thread.createdAt,
      upvotes: thread._count.likes,
      isUpvoted: thread.likes.length > 0,
      status: thread.pinnedReplyId ? "resolved" : "open", // Simplified status
      repliesCount: thread._count.replies,
      questionId: thread.questionId,
      // You would need to add a tags model or parse from content if needed
      tags: [],
    }));

    res.json({ success: true, data: formattedThreads });
  } catch (error) {
    console.error("Error fetching threads:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: POST /api/study-group/:studyRoomId/discussions
 * Creates a new discussion thread.
 */
const createThread = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { studyRoomId } = req.params;

    if (!uid) {
      return res
        .status(404)
        .json({ success: false, error: "uid is required." });
    }

    if (!studyRoomId) {
      return res
        .status(404)
        .json({ success: false, error: "studyRoomId is required." });
    }

    const validation = createThreadSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        errors: validation.error.flatten().fieldErrors,
      });
    }
    const { title, content, questionId } = validation.data;

    if (!title) {
      return res
        .status(404)
        .json({ success: false, error: "title is required." });
    }
    if (!content) {
      return res
        .status(404)
        .json({ success: false, error: "content is required." });
    }
    if (!questionId) {
      return res
        .status(404)
        .json({ success: false, error: "questionId is required." });
    }

    const membership = await prisma.studyRoomMember.findUnique({
      where: { studyRoomId_userId: { studyRoomId, userId: uid } },
    });
    if (!membership) {
      return res
        .status(403)
        .json({ success: false, error: "You are not a member of this group." });
    }

    const newThread = await prisma.discussionThread.create({
      data: {
        title,
        content,
        studyRoomId,
        authorId: uid,
        questionId,
      },
    });

    res.status(201).json({
      success: true,
      message: "Thread created successfully.",
      data: newThread,
    });
  } catch (error) {
    console.error("Error creating thread:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: GET /api/discussions/:threadId
 * Fetches a single thread and all its replies.
 */
const getThreadDetails = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { threadId } = req.params;

    if (!threadId) {
      return res
        .status(404)
        .json({ success: false, error: "Thread Id is required." });
    }

    const thread = await prisma.discussionThread.findUnique({
      where: { id: threadId },
      include: {
        author: {
          select: {
            id: true,
            fullName: true,
            badges: { include: { badge: true } },
          },
        },
        replies: {
          include: {
            author: {
              select: {
                id: true,
                fullName: true,
                badges: { include: { badge: true } },
              },
            },
            _count: { select: { likes: true } },
            likes: { where: { userId: uid } }, // Check if current user liked each reply
          },
          orderBy: { createdAt: "asc" },
        },
        _count: { select: { likes: true, replies: true } },
        likes: { where: { userId: uid } },
      },
    });

    if (!thread) {
      return res
        .status(404)
        .json({ success: false, error: "Thread not found." });
    }

    // Authorization (optional but good practice): Check if user is in the thread's study group
    const membership = await prisma.studyRoomMember.findUnique({
      where: {
        studyRoomId_userId: { studyRoomId: thread.studyRoomId, userId: uid },
      },
    });
    if (!membership) {
      return res.status(403).json({ success: false, error: "Access denied." });
    }

    const formattedThread = {
      id: thread.id,
      title: thread.title,
      content: thread.content,
      author: {
        /* format author as before */
      },
      timestamp: thread.createdAt,
      upvotes: thread._count.likes,
      isUpvoted: thread.likes.length > 0,
      status: thread.pinnedReplyId ? "resolved" : "open",
      replies: thread.replies.map((reply) => ({
        id: reply.id,
        content: reply.content,
        author: {
          /* format author as before */
        },
        timestamp: reply.createdAt,
        upvotes: reply._count.likes,
        isUpvoted: reply.likes.length > 0,
        isPinned: thread.pinnedReplyId === reply.id,
      })),
    };

    res.json({ success: true, data: formattedThread });
  } catch (error) {
    console.error("Error fetching thread details:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: POST /api/discussions/:threadId/replies
 * Adds a new reply to a thread.
 */
const addReply = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { threadId } = req.params;

    if (!uid) {
      return res
        .status(400)
        .json({ success: false, error: "Uid is required." });
    }

    if (!threadId) {
      return res
        .status(400)
        .json({ success: false, error: "Thread ID is required." });
    }

    const validation = createReplySchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        errors: validation.error.flatten().fieldErrors,
      });
    }
    const { content, parentId } = validation.data;

    if (!parentId) {
      return res
        .status(404)
        .json({ success: false, error: "Parent Id is required." });
    }

    // Authorization: Find the thread to get its study room ID
    const thread = await prisma.discussionThread.findUnique({
      where: { id: threadId },
      select: { studyRoomId: true },
    });
    if (!thread) {
      return res
        .status(404)
        .json({ success: false, error: "Thread not found." });
    }
    const membership = await prisma.studyRoomMember.findUnique({
      where: {
        studyRoomId_userId: { studyRoomId: thread.studyRoomId, userId: uid },
      },
    });
    if (!membership) {
      return res
        .status(403)
        .json({ success: false, error: "You cannot reply in this group." });
    }

    const newReply = await prisma.discussionReply.create({
      data: {
        content,
        threadId,
        authorId: uid,
        parentId,
      },
    });

    res
      .status(201)
      .json({ success: true, message: "Reply added.", data: newReply });
  } catch (error) {
    console.error("Error adding reply:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: POST /api/discussions/replies/:replyId/like
 * Toggles a like (upvote) on a reply.
 */
const toggleReplyLike = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { replyId } = req.params;

    if (!replyId) {
      return res
        .status(404)
        .json({ success: false, error: "Reply Id is required." });
    }

    const existingLike = await prisma.discussionLike.findFirst({
      where: { replyId, userId: uid },
    });

    if (existingLike) {
      // User has already liked, so unlike it using its unique ID
      await prisma.discussionLike.delete({ where: { id: existingLike.id } });
      res.json({ success: true, message: "Upvote removed." });
    } else {
      // User has not liked, so add a like
      await prisma.discussionLike.create({
        data: { replyId, userId: uid },
      });
      res.json({ success: true, message: "Reply upvoted." });
    }
  } catch (error) {
    console.error("Error toggling reply like:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

const toggleThreadLike = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { threadId } = req.params;

    if (!threadId) {
      return res
        .status(404)
        .json({ success: false, error: "Thread Id is required." });
    }

    // Use findFirst with the unique constraint
    const existingLike = await prisma.discussionLike.findFirst({
      where: { threadId, userId: uid },
    });

    if (existingLike) {
      // User has already liked, so unlike it using its unique ID
      await prisma.discussionLike.delete({ where: { id: existingLike.id } });
      res.json({ success: true, message: "Upvote removed." });
    } else {
      // User has not liked, so add a like
      await prisma.discussionLike.create({
        data: { threadId, userId: uid },
      });
      res.json({ success: true, message: "Thread upvoted." });
    }
  } catch (error) {
    console.error("Error toggling thread like:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

/**
 * ROUTE: POST /api/discussions/:threadId/pin
 * Pins a reply as the "Best Answer" and resolves the thread.
 */
const pinReply = async (req: Request, res: Response) => {
  try {
    const { uid } = req.user;
    const { threadId } = req.params;
    const { replyId } = req.body; // Expecting { "replyId": "..." } or { "replyId": null }

    if (!threadId) {
      return res
        .status(404)
        .json({ success: false, error: "Thread Id is required." });
    }

    const thread = await prisma.discussionThread.findUnique({
      where: { id: threadId },
      include: { author: true },
    });

    if (!thread) {
      return res
        .status(404)
        .json({ success: false, error: "Thread not found." });
    }

    // Only the thread author can pin a reply
    if (thread.authorId !== uid) {
      return res.status(403).json({
        success: false,
        error: "Only the thread author can select a best answer.",
      });
    }

    // If the current pinned reply is clicked again, unpin it.
    const newPinnedId = thread.pinnedReplyId === replyId ? null : replyId;

    await prisma.discussionThread.update({
      where: { id: threadId },
      data: { pinnedReplyId: newPinnedId },
    });

    res.json({ success: true, message: "Best answer updated." });
  } catch (error) {
    console.error("Error pinning reply:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

export {
  getThreads,
  createThread,
  getThreadDetails,
  addReply,
  toggleThreadLike,
  toggleReplyLike,
  pinReply,
};
