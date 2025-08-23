-- CreateIndex
CREATE INDEX "ExamSession_examId_idx" ON "public"."ExamSession"("examId");

-- CreateIndex
CREATE INDEX "Question_examSessionId_idx" ON "public"."Question"("examSessionId");

-- CreateIndex
CREATE INDEX "Subtopic_topicId_idx" ON "public"."Subtopic"("topicId");

-- CreateIndex
CREATE INDEX "Topic_subjectId_idx" ON "public"."Topic"("subjectId");

-- CreateIndex
CREATE INDEX "UserSubtopicPerformance_userId_subtopicId_idx" ON "public"."UserSubtopicPerformance"("userId", "subtopicId");

-- CreateIndex
CREATE INDEX "UserTestInstanceSummary_userId_examSessionId_completedAt_idx" ON "public"."UserTestInstanceSummary"("userId", "examSessionId", "completedAt" DESC);
