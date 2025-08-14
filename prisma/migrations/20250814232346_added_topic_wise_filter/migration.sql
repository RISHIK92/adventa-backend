-- CreateTable
CREATE TABLE "public"."UserTopicPerformance" (
    "userId" TEXT NOT NULL,
    "topicId" INTEGER NOT NULL,
    "totalAttempted" INTEGER NOT NULL DEFAULT 0,
    "totalCorrect" INTEGER NOT NULL DEFAULT 0,
    "totalIncorrect" INTEGER NOT NULL DEFAULT 0,
    "totalTimeTakenSec" INTEGER NOT NULL DEFAULT 0,
    "accuracyPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "avgTimePerQuestionSec" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTopicPerformance_pkey" PRIMARY KEY ("userId","topicId")
);

-- CreateTable
CREATE TABLE "public"."TestTopicSnapshot" (
    "id" TEXT NOT NULL,
    "testInstanceId" TEXT NOT NULL,
    "topicId" INTEGER NOT NULL,
    "accuracyPercentBefore" DECIMAL(5,2) NOT NULL,
    "totalAttemptedBefore" INTEGER NOT NULL,

    CONSTRAINT "TestTopicSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserTopicPerformance_userId_accuracyPercent_idx" ON "public"."UserTopicPerformance"("userId", "accuracyPercent");

-- CreateIndex
CREATE UNIQUE INDEX "TestTopicSnapshot_testInstanceId_topicId_key" ON "public"."TestTopicSnapshot"("testInstanceId", "topicId");

-- AddForeignKey
ALTER TABLE "public"."UserTopicPerformance" ADD CONSTRAINT "UserTopicPerformance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserTopicPerformance" ADD CONSTRAINT "UserTopicPerformance_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "public"."Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TestTopicSnapshot" ADD CONSTRAINT "TestTopicSnapshot_testInstanceId_fkey" FOREIGN KEY ("testInstanceId") REFERENCES "public"."UserTestInstanceSummary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TestTopicSnapshot" ADD CONSTRAINT "TestTopicSnapshot_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "public"."Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
