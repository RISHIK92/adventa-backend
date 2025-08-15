import { prisma } from "../services/db.js";

export const getTopicAccuracyComparisonData = async (
  testInstanceId: string,
  uid: string
) => {
  const snapshots = await prisma.testTopicSnapshot.findMany({
    where: { testInstanceId },
    include: { topic: { select: { name: true } } },
  });

  if (snapshots.length === 0) {
    return null;
  }

  const topicIds = snapshots.map((s) => s.topicId);

  const latestPerformance = await prisma.userTopicPerformance.findMany({
    where: {
      userId: uid,
      topicId: { in: topicIds },
    },
  });

  const latestPerformanceMap = new Map(
    latestPerformance.map((p) => [p.topicId, p])
  );

  return snapshots.map((snapshot) => {
    const afterPerf = latestPerformanceMap.get(snapshot.topicId);
    const accuracyAfter = afterPerf
      ? afterPerf.accuracyPercent
      : snapshot.accuracyPercentBefore;

    return {
      topicId: snapshot.topicId,
      topicName: snapshot.topic.name,
      accuracyBefore: Number(snapshot.accuracyPercentBefore).toFixed(2),
      accuracyAfter: Number(accuracyAfter).toFixed(2),
      change: (
        Number(accuracyAfter) - Number(snapshot.accuracyPercentBefore)
      ).toFixed(2),
    };
  });
};
