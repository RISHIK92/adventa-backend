-- CreateTable
CREATE TABLE "public"."UserTopicDifficultyPerformance" (
    "userId" TEXT NOT NULL,
    "topicId" INTEGER NOT NULL,
    "difficultyLevel" "public"."DifficultyLevel" NOT NULL,
    "totalAttempted" INTEGER NOT NULL DEFAULT 0,
    "totalCorrect" INTEGER NOT NULL DEFAULT 0,
    "totalTimeTakenSec" INTEGER NOT NULL DEFAULT 0,
    "accuracyPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "avgTimePerQuestionSec" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTopicDifficultyPerformance_pkey" PRIMARY KEY ("userId","topicId","difficultyLevel")
);

-- AddForeignKey
ALTER TABLE "public"."UserTopicDifficultyPerformance" ADD CONSTRAINT "UserTopicDifficultyPerformance_userId_topicId_fkey" FOREIGN KEY ("userId", "topicId") REFERENCES "public"."UserTopicPerformance"("userId", "topicId") ON DELETE CASCADE ON UPDATE CASCADE;
