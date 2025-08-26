import { prisma } from "../services/db.js";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Recalculates the platform-wide average accuracy for a given set of topics.
 * @param topicIds - An array of topic IDs to update.
 */
export const updateGlobalTopicAverages = async (topicIds: number[]) => {
  console.log(`Updating global averages for ${topicIds.length} topics.`);
  try {
    for (const topicId of topicIds) {
      const result = await prisma.userTopicPerformance.aggregate({
        _avg: {
          accuracyPercent: true,
        },
        where: { topicId },
      });

      const average = result._avg.accuracyPercent ?? new Decimal(0);

      await prisma.topic.update({
        where: { id: topicId },
        data: { averageAccuracyPercent: average },
      });
    }
  } catch (error) {
    console.error("Error updating global topic averages:", error);
  }
};

/**
 * Recalculates the platform-wide average accuracy for a given set of subtopics.
 * @param subtopicIds - An array of subtopic IDs to update.
 */
export const updateGlobalSubtopicAverages = async (subtopicIds: number[]) => {
  console.log(`Updating global averages for ${subtopicIds.length} subtopics.`);
  try {
    for (const subtopicId of subtopicIds) {
      const result = await prisma.userSubtopicPerformance.aggregate({
        _avg: {
          accuracyPercent: true,
        },
        where: { subtopicId },
      });

      const average = result._avg.accuracyPercent ?? new Decimal(0);

      await prisma.subtopic.update({
        where: { id: subtopicId },
        data: { averageAccuracyPercent: average },
      });
    }
  } catch (error) {
    console.error("Error updating global subtopic averages:", error);
  }
};

/**
 * Recalculates a specific user's overall average accuracy across all their topics.
 * @param userId - The ID of the user to update.
 */
export const updateUserOverallAverage = async (userId: string) => {
  console.log(`Updating overall average for user ${userId}.`);
  try {
    const result = await prisma.userTopicPerformance.aggregate({
      _avg: {
        accuracyPercent: true,
      },
      where: { userId },
    });

    const average = result._avg.accuracyPercent ?? new Decimal(0);

    await prisma.user.update({
      where: { id: userId },
      data: { overallAverageAccuracy: average },
    });
  } catch (error) {
    console.error(`Error updating overall average for user ${userId}:`, error);
  }
};

export const updateGlobalSubjectAverages = async (subjectIds: number[]) => {
  if (!subjectIds || subjectIds.length === 0) return;
  console.log(`Updating global averages for ${subjectIds.length} subjects.`);
  try {
    for (const subjectId of subjectIds) {
      const result = await prisma.userSubjectPerformance.aggregate({
        _avg: {
          accuracyPercent: true,
        },
        where: { subjectId },
      });

      const average = result._avg.accuracyPercent ?? new Decimal(0);

      await prisma.subject.update({
        where: { id: subjectId },
        data: { averageAccuracyPercent: average },
      });
    }
  } catch (error) {
    console.error("Error updating global subject averages:", error);
  }
};
