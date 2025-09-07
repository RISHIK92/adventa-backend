-- AlterTable
ALTER TABLE "public"."Question" ADD COLUMN     "embedding" vector(1024);

-- AlterTable
ALTER TABLE "public"."UserTestInstanceSummary" ADD COLUMN     "generatedQuestionIds" JSONB;

-- CreateIndex
CREATE INDEX "UserTestAnswer_userId_isCorrect_idx" ON "public"."UserTestAnswer"("userId", "isCorrect");
