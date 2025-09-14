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

export const updateDailyPerformanceAndStreak = async (
  userId: string,
  testPerformance: {
    totalAttempted: number;
    totalCorrect: number;
    timeTakenSec: number;
  }
) => {
  // Ensure we don't divide by zero
  if (testPerformance.totalAttempted === 0) {
    console.log(
      `User ${userId} had 0 attempted questions. Skipping daily performance update.`
    );
    return;
  }

  // Get the start of today's date (in UTC for consistency)
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  try {
    await prisma.$transaction(async (tx) => {
      // --- Step 1: Create or Update Today's Performance Snapshot ---

      const todaysAccuracy =
        (testPerformance.totalCorrect / testPerformance.totalAttempted) * 100;

      const existingSnapshot = await tx.userDailyPerformanceSnapshot.findUnique(
        {
          where: { userId_date: { userId, date: today } },
        }
      );

      if (existingSnapshot) {
        // --- UPDATE existing snapshot ---
        const newTotalAttempted =
          existingSnapshot.questionsAttempted + testPerformance.totalAttempted;
        // Calculate the new weighted average accuracy
        const existingTotalCorrect =
          (existingSnapshot.accuracyPercent.toNumber() / 100) *
          existingSnapshot.questionsAttempted;
        const newTotalCorrect =
          existingTotalCorrect + testPerformance.totalCorrect;
        const newAverageAccuracy = (newTotalCorrect / newTotalAttempted) * 100;

        await tx.userDailyPerformanceSnapshot.update({
          where: { id: existingSnapshot.id },
          data: {
            questionsAttempted: { increment: testPerformance.totalAttempted },
            timeSpentSec: { increment: testPerformance.timeTakenSec },
            accuracyPercent: newAverageAccuracy,
          },
        });
      } else {
        // --- CREATE new snapshot ---
        await tx.userDailyPerformanceSnapshot.create({
          data: {
            userId,
            date: today,
            questionsAttempted: testPerformance.totalAttempted,
            timeSpentSec: testPerformance.timeTakenSec,
            accuracyPercent: todaysAccuracy,
          },
        });
      }

      // --- Step 2: Recalculate and Update User's Streak ---

      // Fetch all of the user's snapshots, ordered by most recent date
      const allSnapshots = await tx.userDailyPerformanceSnapshot.findMany({
        where: { userId },
        orderBy: { date: "desc" },
      });

      let currentStreak = 0;
      if (allSnapshots.length > 0) {
        let currentDate = new Date();
        currentDate.setUTCHours(0, 0, 0, 0);

        if (!allSnapshots[0]) return;

        // Check if the most recent snapshot is today or yesterday
        const mostRecentDate = new Date(allSnapshots[0].date);
        const timeDiff = currentDate.getTime() - mostRecentDate.getTime();
        const dayDiff = Math.round(timeDiff / (1000 * 60 * 60 * 24));

        if (dayDiff <= 1) {
          currentStreak = 1;
          // Loop through the rest of the snapshots to find consecutive days
          for (let i = 0; i < allSnapshots.length - 1; i++) {
            const currentSnapDate = new Date(allSnapshots[i]!.date);
            const nextSnapDate = new Date(allSnapshots[i + 1]!.date);

            const diffBetweenSnaps =
              currentSnapDate.getTime() - nextSnapDate.getTime();
            const daysBetween = Math.round(
              diffBetweenSnaps / (1000 * 60 * 60 * 24)
            );

            if (daysBetween === 1) {
              currentStreak++;
            } else {
              // The streak is broken
              break;
            }
          }
        }
      }

      // 3. Update the streak on the User model
      await tx.user.update({
        where: { id: userId },
        data: { streak: currentStreak },
      });

      console.log(
        `Updated daily performance for user ${userId}. New streak: ${currentStreak}`
      );
    });
  } catch (error) {
    console.error(
      `Failed to update daily performance and streak for user ${userId}:`,
      error
    );
  }
};
