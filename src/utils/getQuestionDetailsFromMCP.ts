import { PrismaClient, DifficultyLevel } from "@prisma/client";
import type { JsonValue } from "@prisma/client/runtime/library";

const prisma = new PrismaClient();

export interface QuestionDetails {
  questionText: string;
  solutionText: string;
  options: JsonValue | null;
  correctOption: string;
  difficulty: DifficultyLevel;
  imageUrl: string | null;
  solutionImageUrl: string | null;
  context: {
    subject: string;
    topic: string;
    subtopic: string;
  };
}

/**
 * Fetches all necessary details for a given question from the database.
 * This includes the question itself, its solution, and its hierarchical context
 * (Subject -> Topic -> Subtopic).
 *
 * @param questionId The ID of the question to fetch.
 * @returns A structured object with all question details, or null if not found.
 */
export const getQuestionDetailsFromMCP = async (
  questionId: number
): Promise<QuestionDetails | null> => {
  console.log(
    `[Job] Fetching details for question ${questionId} from database...`
  );
  try {
    const questionFromDb = await prisma.question.findUnique({
      where: {
        id: questionId,
      },
      // Use 'include' to efficiently fetch related data in one query
      include: {
        subtopic: {
          include: {
            topic: {
              include: {
                subject: true, // Includes the full subject record
              },
            },
          },
        },
      },
    });

    // Handle the case where the question does not exist
    if (!questionFromDb) {
      console.error(
        `[Job] Question with ID ${questionId} not found in the database.`
      );
      return null;
    }

    // Structure the data into a clean object for the AI
    const details: QuestionDetails = {
      questionText: questionFromDb.question,
      solutionText: questionFromDb.solution,
      options: questionFromDb.options,
      correctOption: questionFromDb.correctOption,
      difficulty: questionFromDb.humanDifficultyLevel,
      imageUrl: questionFromDb.imageUrl,
      solutionImageUrl: questionFromDb.imagesolurl,
      context: {
        subject: questionFromDb.subtopic.topic.subject.name,
        topic: questionFromDb.subtopic.topic.name,
        subtopic: questionFromDb.subtopic.name,
      },
    };

    return details;
  } catch (error) {
    console.error(
      `[Job] Failed to fetch question details from database for ID ${questionId}:`,
      error
    );
    return null;
  }
};
