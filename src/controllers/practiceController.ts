import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const getMistakesByExam = async (req: Request, res: Response) => {
  const { uid } = req.user;
  const { examId } = req.params;

  if (!examId) {
    return res.status(400).json({ error: "Exam ID is required." });
  }

  try {
    const mistakes = await prisma.userTestAnswer.findMany({
      where: {
        userId: uid,
        status: "Incorrect",
        testInstance: {
          examId: parseInt(examId, 10),
        },
      },
      include: {
        question: {
          include: {
            subtopic: {
              select: {
                name: true,
                topic: {
                  // And the parent topic for broader context
                  select: {
                    name: true,
                    subject: {
                      // And the subject
                      select: {
                        name: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        testInstance: {
          select: {
            id: true,
            testName: true,
            completedAt: true,
          },
        },
      },
      orderBy: {
        testInstance: {
          completedAt: "desc",
        },
      },
    });

    if (!mistakes || mistakes.length === 0) {
      return res.status(200).json([]);
    }

    const formattedMistakes = mistakes.map((mistake) => ({
      test: {
        id: mistake.testInstance.id,
        name: mistake.testInstance.testName,
        completedAt: mistake.testInstance.completedAt,
      },
      question: {
        id: mistake.question.id,
        text: mistake.question.question,
        options: mistake.question.options,
        correctOption: mistake.question.correctOption,
        solution: mistake.question.solution,
        imageUrl: mistake.question.imageUrl,
        imagesolurl: mistake.question.imagesolurl,
        yourAnswer: mistake.userAnswer,
      },
      context: {
        subject: mistake.question.subtopic.topic.subject.name,
        topic: mistake.question.subtopic.topic.name,
        subtopic: mistake.question.subtopic.name,
      },
      answeredOn: mistake.testInstance.completedAt,
    }));

    res.status(200).json({ data: formattedMistakes, success: true });
  } catch (error) {
    console.error("Failed to retrieve mistakes:", error);
    res.status(500).json({ error: "An internal server error occurred." });
  }
};

export const getSubjectsWithTopicsByExam = async (
  req: Request,
  res: Response
) => {
  const { examId } = req.params;

  if (!examId) {
    return res
      .status(400)
      .json({ success: false, error: "Exam ID is required." });
  }

  const numericExamId = parseInt(examId, 10);
  if (isNaN(numericExamId)) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid Exam ID format." });
  }

  try {
    const subjectsAndTopics = await prisma.subject.findMany({
      where: {
        examId: numericExamId,
      },
      select: {
        id: true,
        name: true,
        topics: {
          select: {
            id: true,
            name: true,
          },
          orderBy: {
            name: "asc",
          },
        },
      },
      orderBy: {
        name: "asc",
      },
    });

    if (subjectsAndTopics.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    res.status(200).json({ success: true, data: subjectsAndTopics });
  } catch (error) {
    console.error("Failed to retrieve subjects and topics by exam:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

const getPyqsByTopicAndExam = async (req: Request, res: Response) => {
  const { examId, topicId } = req.params;

  // 1. Validate both IDs
  if (!examId || !topicId) {
    return res.status(400).json({
      success: false,
      error: "Both Exam ID and Topic ID are required.",
    });
  }

  const numericExamId = parseInt(examId, 10);
  const numericTopicId = parseInt(topicId, 10);

  if (isNaN(numericExamId) || isNaN(numericTopicId)) {
    return res.status(400).json({
      success: false,
      error: "Invalid ID format. Both IDs must be numbers.",
    });
  }

  try {
    // 2. The Prisma query is now updated with an AND condition
    const pyqs = await prisma.question.findMany({
      where: {
        // Condition 1: Must belong to the specified topic
        subtopic: {
          topicId: numericTopicId,
        },
        // Condition 2: The question's session MUST belong to the specified exam
        examSession: {
          examId: numericExamId,
        },
      },
      include: {
        examSession: {
          select: {
            name: true,
            sessionDate: true,
          },
        },
        subtopic: {
          select: {
            name: true,
          },
        },
      },
      orderBy: {
        examSession: {
          sessionDate: "desc",
        },
      },
    });

    if (pyqs.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    // 3. The formatting logic remains the same, as it's already perfect
    const formattedPyqs = pyqs.map((q) => ({
      id: q.id,
      text: q.question,
      options: q.options,
      correctOption: q.correctOption,
      solution: q.solution,
      imageUrl: q.imageUrl,
      imagesolurl: q.imagesolurl,
      subtopicName: q.subtopic.name,
      examSession: {
        name: q.examSession?.name || "N/A",
        date: q.examSession?.sessionDate,
      },
    }));

    res.status(200).json({ success: true, data: formattedPyqs });
  } catch (error) {
    console.error("Failed to retrieve PYQs by topic and exam:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};

export { getMistakesByExam, getPyqsByTopicAndExam };
