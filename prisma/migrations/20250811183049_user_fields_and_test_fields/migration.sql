-- CreateEnum
CREATE TYPE "public"."AnswerStatus" AS ENUM ('Correct', 'Incorrect', 'Unattempted');

-- CreateEnum
CREATE TYPE "public"."PersonaTag" AS ENUM ('beginner', 'striker', 'topper');

-- CreateEnum
CREATE TYPE "public"."DifficultyLevel" AS ENUM ('Easy', 'Medium', 'Hard', 'Elite');

-- CreateEnum
CREATE TYPE "public"."TestType" AS ENUM ('mock', 'quiz', 'drill', 'diagnostic', 'group');

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "fullName" TEXT,
ADD COLUMN     "personaTag" "public"."PersonaTag",
ADD COLUMN     "primaryExamId" INTEGER;

-- CreateTable
CREATE TABLE "public"."Exam" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Subject" (
    "id" SERIAL NOT NULL,
    "examId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Topic" (
    "id" SERIAL NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Subtopic" (
    "id" SERIAL NOT NULL,
    "topicId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Subtopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Question" (
    "id" SERIAL NOT NULL,
    "subtopicId" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "shortcut" TEXT,
    "equations" TEXT,
    "imageUrl" TEXT,
    "imagesolurl" TEXT,
    "options" JSONB,
    "correctOption" TEXT NOT NULL,
    "solution" TEXT NOT NULL,
    "examname" TEXT NOT NULL,
    "humanDifficultyLevel" "public"."DifficultyLevel" NOT NULL,
    "questionType" TEXT[],
    "wordCountQuestion" INTEGER,
    "wordCountSolution" INTEGER,
    "averageTimeSec" INTEGER,
    "Report" BOOLEAN,
    "ReportReason" TEXT,
    "predictedDifficultyScore" DOUBLE PRECISION,
    "platformAvgTimeSec" INTEGER,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserSubtopicPerformance" (
    "userId" TEXT NOT NULL,
    "subtopicId" INTEGER NOT NULL,
    "totalAttempted" INTEGER NOT NULL DEFAULT 0,
    "totalCorrect" INTEGER NOT NULL DEFAULT 0,
    "totalIncorrect" INTEGER NOT NULL DEFAULT 0,
    "totalTimeTakenSec" INTEGER NOT NULL DEFAULT 0,
    "accuracyPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "avgTimePerQuestionSec" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSubtopicPerformance_pkey" PRIMARY KEY ("userId","subtopicId")
);

-- CreateTable
CREATE TABLE "public"."UserExamOverallSummary" (
    "userId" TEXT NOT NULL,
    "examId" INTEGER NOT NULL,
    "totalQuestionsAttempted" INTEGER NOT NULL DEFAULT 0,
    "totalCorrect" INTEGER NOT NULL DEFAULT 0,
    "totalIncorrect" INTEGER NOT NULL DEFAULT 0,
    "overallAccuracyPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "totalMockTestsCompleted" INTEGER NOT NULL DEFAULT 0,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserExamOverallSummary_pkey" PRIMARY KEY ("userId","examId")
);

-- CreateTable
CREATE TABLE "public"."UserTestInstanceSummary" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "testName" TEXT,
    "testType" "public"."TestType" NOT NULL,
    "score" INTEGER NOT NULL,
    "totalMarks" INTEGER NOT NULL,
    "percentile" DECIMAL(5,2),
    "totalQuestions" INTEGER NOT NULL,
    "numCorrect" INTEGER NOT NULL,
    "numIncorrect" INTEGER NOT NULL,
    "numUnattempted" INTEGER NOT NULL,
    "timeTakenSec" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserTestInstanceSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserTestAnswer" (
    "id" TEXT NOT NULL,
    "testInstanceId" TEXT NOT NULL,
    "questionId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "userAnswer" TEXT,
    "isCorrect" BOOLEAN NOT NULL,
    "status" "public"."AnswerStatus" NOT NULL,
    "timeTakenSec" INTEGER NOT NULL,

    CONSTRAINT "UserTestAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Exam_name_key" ON "public"."Exam"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_examId_name_key" ON "public"."Subject"("examId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Topic_subjectId_name_key" ON "public"."Topic"("subjectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Subtopic_topicId_name_key" ON "public"."Subtopic"("topicId", "name");

-- CreateIndex
CREATE INDEX "UserSubtopicPerformance_userId_accuracyPercent_idx" ON "public"."UserSubtopicPerformance"("userId", "accuracyPercent");

-- CreateIndex
CREATE INDEX "UserTestInstanceSummary_userId_completedAt_idx" ON "public"."UserTestInstanceSummary"("userId", "completedAt" DESC);

-- CreateIndex
CREATE INDEX "UserTestAnswer_testInstanceId_idx" ON "public"."UserTestAnswer"("testInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "UserTestAnswer_testInstanceId_questionId_key" ON "public"."UserTestAnswer"("testInstanceId", "questionId");

-- AddForeignKey
ALTER TABLE "public"."User" ADD CONSTRAINT "User_primaryExamId_fkey" FOREIGN KEY ("primaryExamId") REFERENCES "public"."Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Subject" ADD CONSTRAINT "Subject_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Topic" ADD CONSTRAINT "Topic_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "public"."Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Subtopic" ADD CONSTRAINT "Subtopic_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "public"."Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Question" ADD CONSTRAINT "Question_subtopicId_fkey" FOREIGN KEY ("subtopicId") REFERENCES "public"."Subtopic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserSubtopicPerformance" ADD CONSTRAINT "UserSubtopicPerformance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserSubtopicPerformance" ADD CONSTRAINT "UserSubtopicPerformance_subtopicId_fkey" FOREIGN KEY ("subtopicId") REFERENCES "public"."Subtopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserExamOverallSummary" ADD CONSTRAINT "UserExamOverallSummary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserExamOverallSummary" ADD CONSTRAINT "UserExamOverallSummary_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserTestInstanceSummary" ADD CONSTRAINT "UserTestInstanceSummary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserTestAnswer" ADD CONSTRAINT "UserTestAnswer_testInstanceId_fkey" FOREIGN KEY ("testInstanceId") REFERENCES "public"."UserTestInstanceSummary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserTestAnswer" ADD CONSTRAINT "UserTestAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserTestAnswer" ADD CONSTRAINT "UserTestAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
