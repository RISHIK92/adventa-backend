-- CreateEnum
CREATE TYPE "public"."StudyRoomRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateTable
CREATE TABLE "public"."StudyRoom" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudyRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StudyRoomMember" (
    "studyRoomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "public"."StudyRoomRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudyRoomMember_pkey" PRIMARY KEY ("studyRoomId","userId")
);

-- CreateTable
CREATE TABLE "public"."GroupTest" (
    "id" TEXT NOT NULL,
    "studyRoomId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "testSettings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GroupTestParticipant" (
    "groupTestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userTestInstanceId" TEXT NOT NULL,

    CONSTRAINT "GroupTestParticipant_pkey" PRIMARY KEY ("groupTestId","userId")
);

-- CreateTable
CREATE TABLE "public"."GroupTestReport" (
    "id" TEXT NOT NULL,
    "groupTestId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "groupAverageScore" DOUBLE PRECISION NOT NULL,
    "groupAverageTimePerQuestion" DOUBLE PRECISION NOT NULL,
    "groupAverageAccuracy" DOUBLE PRECISION NOT NULL,
    "topicPerformanceComparison" JSONB NOT NULL,
    "aiSummary" TEXT NOT NULL,

    CONSTRAINT "GroupTestReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."_StudyRoomAdmins" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_StudyRoomAdmins_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupTestParticipant_userTestInstanceId_key" ON "public"."GroupTestParticipant"("userTestInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupTestReport_groupTestId_key" ON "public"."GroupTestReport"("groupTestId");

-- CreateIndex
CREATE INDEX "_StudyRoomAdmins_B_index" ON "public"."_StudyRoomAdmins"("B");

-- AddForeignKey
ALTER TABLE "public"."StudyRoomMember" ADD CONSTRAINT "StudyRoomMember_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomMember" ADD CONSTRAINT "StudyRoomMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GroupTest" ADD CONSTRAINT "GroupTest_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GroupTest" ADD CONSTRAINT "GroupTest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GroupTestParticipant" ADD CONSTRAINT "GroupTestParticipant_groupTestId_fkey" FOREIGN KEY ("groupTestId") REFERENCES "public"."GroupTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GroupTestParticipant" ADD CONSTRAINT "GroupTestParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GroupTestParticipant" ADD CONSTRAINT "GroupTestParticipant_userTestInstanceId_fkey" FOREIGN KEY ("userTestInstanceId") REFERENCES "public"."UserTestInstanceSummary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GroupTestReport" ADD CONSTRAINT "GroupTestReport_groupTestId_fkey" FOREIGN KEY ("groupTestId") REFERENCES "public"."GroupTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_StudyRoomAdmins" ADD CONSTRAINT "_StudyRoomAdmins_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_StudyRoomAdmins" ADD CONSTRAINT "_StudyRoomAdmins_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
