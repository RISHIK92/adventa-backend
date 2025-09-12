import type { Request, Response } from "express";
import { prisma } from "../services/db.js";

/**
 * ROUTE: GET /api/analytics/overview/:examId
 * Fetches and aggregates all data needed for the main analytics dashboard.
 */
export const getAnalyticsData = async (req: Request, res: Response) => {
  try {
    // The user's ID is extracted from the authenticated request
    const { uid } = req.user;

    // --- 1. GATHER ALL DATA IN PARALLEL ---
    // We run all database queries concurrently using Promise.all for maximum efficiency.
    const [
      subjectPerformance,
      difficultyPerformance,
      progressTrend,
      allUserScores,
      currentUser,
      topPerformers,
      subtopicPerformance,
      globalStats,
      communitySubjectAverages,
    ] = await Promise.all([
      // Query 1: Fetches the user's performance for every subject they've attempted.
      // It deeply includes related topics (chapters) and subtopics for detailed breakdowns.
      prisma.userSubjectPerformance.findMany({
        where: { userId: uid },
        include: {
          subject: {
            select: {
              name: true,
              topics: {
                include: {
                  userPerformance: { where: { userId: uid } },
                  subtopics: {
                    include: { userPerformance: { where: { userId: uid } } },
                  },
                },
              },
            },
          },
        },
      }),

      // Query 2: Aggregates the user's performance across all topics, grouped by difficulty.
      prisma.userTopicDifficultyPerformance.groupBy({
        by: ["difficultyLevel"],
        where: { userId: uid },
        _avg: { accuracyPercent: true, avgTimePerQuestionSec: true },
        _sum: { totalAttempted: true, totalCorrect: true },
      }),

      // Query 3: Fetches the last 30 daily performance snapshots for historical trend charts.
      prisma.userDailyPerformanceSnapshot.findMany({
        where: { userId: uid },
        orderBy: { date: "asc" },
        take: 30,
      }),

      // Query 4: Fetches all user scores to calculate a global rank and percentile.
      prisma.user.findMany({ select: { score: true } }),

      // Query 5: Fetches specific stats for the currently logged-in user.
      prisma.user.findUnique({
        where: { id: uid },
        select: { score: true, overallAverageAccuracy: true, streak: true },
      }),

      // Query 6: Fetches the top 5 performers on the platform.
      prisma.user.findMany({
        orderBy: { score: "desc" },
        take: 5,
        select: { fullName: true, overallAverageAccuracy: true },
      }),

      // Query 7: Fetches the user's performance for every subtopic they've attempted.
      prisma.userSubtopicPerformance.findMany({
        where: { userId: uid },
        include: {
          subtopic: {
            select: {
              name: true,
              topic: {
                select: { name: true, subject: { select: { name: true } } },
              },
            },
          },
        },
      }),

      // Query 8: Calculates the average accuracy across all users on the platform.
      prisma.user.aggregate({
        where: { overallAverageAccuracy: { not: null } },
        _avg: { overallAverageAccuracy: true },
      }),

      prisma.subject.findMany({
        select: {
          name: true,
          averageAccuracyPercent: true,
        },
      }),
    ]);

    // --- 2. PROCESS AND FORMAT DATA FOR THE FRONTEND ---

    // Format Subject, Chapter, and Time Distribution data
    const formattedSubjects = subjectPerformance.map((sp) => ({
      name: sp.subject.name,
      color: "hsl(var(--chart-1))",
      accuracy: Number(sp.accuracyPercent.toFixed(2)),
      questionsAttempted: sp.totalAttempted,
      questionsCorrect: sp.totalCorrect,
      avgTimePerQuestion: Number(
        (sp.avgTimePerQuestionSec.toNumber() / 60).toFixed(2)
      ),
      totalTimeSpent: Number((sp.totalTimeTakenSec / 3600).toFixed(2)),
      chapters: sp.subject.topics.map((t) => ({
        name: t.name,
        accuracy: Number(
          t.userPerformance[0]?.accuracyPercent?.toFixed(2) ?? 0
        ),
        attempted: t.userPerformance[0]?.totalAttempted ?? 0,
        correct: t.userPerformance[0]?.totalCorrect ?? 0,
        avgTime: Number(
          (
            (t.userPerformance[0]?.avgTimePerQuestionSec?.toNumber() ?? 0) / 60
          ).toFixed(2)
        ),
      })),
    }));

    const timeDistributionData = formattedSubjects.map((s) => ({
      name: s.name,
      value: Number(s.totalTimeSpent.toFixed(2)),
      color: s.color,
    }));

    // Format Difficulty data
    const formattedDifficulty = difficultyPerformance.map((dp) => ({
      level: dp.difficultyLevel,
      accuracy: Number(dp._avg.accuracyPercent?.toFixed(2) ?? 0),
      attempted: dp._sum.totalAttempted ?? 0,
      correct: dp._sum.totalCorrect ?? 0,
      avgTime: Number(
        ((dp._avg.avgTimePerQuestionSec?.toNumber() ?? 0) / 60).toFixed(2)
      ),
    }));

    const overallStats = {
      totalAttempted: formattedSubjects.reduce(
        (sum, s) => sum + s.questionsAttempted,
        0
      ),
      totalCorrect: formattedSubjects.reduce(
        (sum, s) => sum + s.questionsCorrect,
        0
      ),
      totalTime: Number(
        formattedSubjects
          .reduce((sum, s) => sum + s.totalTimeSpent, 0)
          .toFixed(2)
      ),
      get avgAccuracy() {
        return this.totalAttempted > 0
          ? Number(((this.totalCorrect / this.totalAttempted) * 100).toFixed(2))
          : 0;
      },
    };

    const last7DaysProgress = progressTrend.slice(-7);

    let accuracyImprovementLast7Days = 0;

    if (last7DaysProgress.length > 1) {
      const first = last7DaysProgress[0];
      const last = last7DaysProgress[last7DaysProgress.length - 1];
      if (
        !first ||
        !last ||
        first.accuracyPercent == null ||
        last.accuracyPercent == null ||
        typeof first.accuracyPercent.toNumber !== "function" ||
        typeof last.accuracyPercent.toNumber !== "function"
      ) {
        accuracyImprovementLast7Days = 0;
      } else {
        const firstDayAccuracy = Number(first.accuracyPercent.toFixed(2));
        const lastDayAccuracy = Number(last.accuracyPercent.toFixed(2));
        accuracyImprovementLast7Days = Number(
          (lastDayAccuracy - firstDayAccuracy).toFixed(2)
        );
      }
    }

    const weeklyStats = {
      questionsAttemptedLast7Days: last7DaysProgress.reduce(
        (sum, p) => sum + p.questionsAttempted,
        0
      ),
      timeSpentLast7Days: Number(
        last7DaysProgress
          .reduce((sum, p) => sum + p.timeSpentSec / 3600, 0)
          .toFixed(2)
      ),
      accuracyImprovementLast7Days: accuracyImprovementLast7Days,
    };

    // Format Community data
    const sortedScores = allUserScores
      .map((u) => u.score?.toNumber() ?? 0)
      .sort((a, b) => b - a);
    const userRank =
      sortedScores.indexOf(currentUser?.score?.toNumber() ?? 0) + 1;
    const percentile =
      userRank > 0 ? 100 - (userRank / sortedScores.length) * 100 : 0;

    const communityData = {
      userRank: userRank || allUserScores.length,
      totalUsers: allUserScores.length,
      percentile: Math.round(percentile),
      averageAccuracy: Number(
        globalStats._avg.overallAverageAccuracy?.toFixed(2) ?? 0
      ),
      userAccuracy: Number(
        currentUser?.overallAverageAccuracy?.toFixed(2) ?? 0
      ),
      topPerformers: topPerformers.map((p, index) => ({
        name: p.fullName,
        accuracy: Number(p.overallAverageAccuracy?.toFixed(2) ?? 0),
        rank: index + 1,
      })),
    };

    const communitySubjectMap = new Map(
      communitySubjectAverages.map((s) => [s.name, s.averageAccuracyPercent])
    );
    const subjectDataWithCommunity = formattedSubjects.map((subject) => ({
      ...subject,
      communityAverage: Number(
        communitySubjectMap.get(subject.name)?.toFixed(2) ?? 0
      ),
    }));

    // Format Subtopic data
    const formattedSubtopics = subtopicPerformance.map((sub) => ({
      subject: sub.subtopic.topic.subject.name,
      chapter: sub.subtopic.topic.name,
      subtopic: sub.subtopic.name,
      accuracy: Number(sub.accuracyPercent.toFixed(2)),
      attempted: sub.totalAttempted,
    }));

    // --- 3. CONSTRUCT THE FINAL JSON PAYLOAD ---
    // This structure precisely matches the `AnalyticsData` interface for the frontend.
    res.status(200).json({
      success: true,
      data: {
        overallStats,
        weeklyStats,
        subjectData: subjectDataWithCommunity,
        difficultyData: formattedDifficulty,
        progressData: progressTrend.map((p) => ({
          date: p.date.toISOString().split("T")[0],
          accuracy: Number(p.accuracyPercent.toFixed(2)),
          questionsAttempted: p.questionsAttempted,
          timeSpent: Number((p.timeSpentSec / 3600).toFixed(2)),
        })),
        communityData: communityData,
        subtopicData: formattedSubtopics,
        timeDistributionData: timeDistributionData,
        userStreak: currentUser?.streak ?? 0,
        goals: [], // Placeholder
        achievements: [], // Placeholder
      },
    });
  } catch (error) {
    console.error("Error fetching analytics data:", error);
    res
      .status(500)
      .json({ success: false, error: "An internal server error occurred." });
  }
};
