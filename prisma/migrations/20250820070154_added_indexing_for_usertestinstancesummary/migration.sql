-- CreateIndex
CREATE INDEX "UserTestInstanceSummary_userId_examId_testType_completedAt_idx" ON "public"."UserTestInstanceSummary"("userId", "examId", "testType", "completedAt" DESC);
