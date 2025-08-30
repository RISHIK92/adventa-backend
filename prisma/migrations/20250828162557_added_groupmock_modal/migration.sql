-- CreateEnum
CREATE TYPE "public"."ScheduledTestStatus" AS ENUM ('SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."ScheduledGroupTest" (
    "id" TEXT NOT NULL,
    "studyRoomId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationInMinutes" INTEGER NOT NULL,
    "totalQuestions" INTEGER NOT NULL,
    "scheduledStartTime" TIMESTAMP(3) NOT NULL,
    "difficultyDistribution" JSONB NOT NULL,
    "status" "public"."ScheduledTestStatus" NOT NULL DEFAULT 'SCHEDULED',
    "generatedQuestionIds" JSONB,

    CONSTRAINT "ScheduledGroupTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ScheduledGroupTestSubject" (
    "scheduledGroupTestId" TEXT NOT NULL,
    "subjectId" INTEGER NOT NULL,

    CONSTRAINT "ScheduledGroupTestSubject_pkey" PRIMARY KEY ("scheduledGroupTestId","subjectId")
);

-- CreateTable
CREATE TABLE "public"."ScheduledGroupTestParticipant" (
    "scheduledGroupTestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userTestInstanceId" TEXT,

    CONSTRAINT "ScheduledGroupTestParticipant_pkey" PRIMARY KEY ("scheduledGroupTestId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledGroupTestParticipant_userTestInstanceId_key" ON "public"."ScheduledGroupTestParticipant"("userTestInstanceId");

-- AddForeignKey
ALTER TABLE "public"."ScheduledGroupTest" ADD CONSTRAINT "ScheduledGroupTest_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduledGroupTest" ADD CONSTRAINT "ScheduledGroupTest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduledGroupTestSubject" ADD CONSTRAINT "ScheduledGroupTestSubject_scheduledGroupTestId_fkey" FOREIGN KEY ("scheduledGroupTestId") REFERENCES "public"."ScheduledGroupTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduledGroupTestSubject" ADD CONSTRAINT "ScheduledGroupTestSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "public"."Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduledGroupTestParticipant" ADD CONSTRAINT "ScheduledGroupTestParticipant_scheduledGroupTestId_fkey" FOREIGN KEY ("scheduledGroupTestId") REFERENCES "public"."ScheduledGroupTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduledGroupTestParticipant" ADD CONSTRAINT "ScheduledGroupTestParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduledGroupTestParticipant" ADD CONSTRAINT "ScheduledGroupTestParticipant_userTestInstanceId_fkey" FOREIGN KEY ("userTestInstanceId") REFERENCES "public"."UserTestInstanceSummary"("id") ON DELETE SET NULL ON UPDATE CASCADE;
