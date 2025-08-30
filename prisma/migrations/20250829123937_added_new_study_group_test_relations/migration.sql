/*
  Warnings:

  - You are about to drop the `GroupTest` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `GroupTestParticipant` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `GroupTestReport` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ScheduledGroupTestParticipant` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."DiscussionReply" DROP CONSTRAINT "DiscussionReply_parentId_fkey";

-- DropForeignKey
ALTER TABLE "public"."GroupTest" DROP CONSTRAINT "GroupTest_createdById_fkey";

-- DropForeignKey
ALTER TABLE "public"."GroupTest" DROP CONSTRAINT "GroupTest_studyRoomId_fkey";

-- DropForeignKey
ALTER TABLE "public"."GroupTestParticipant" DROP CONSTRAINT "GroupTestParticipant_groupTestId_fkey";

-- DropForeignKey
ALTER TABLE "public"."GroupTestParticipant" DROP CONSTRAINT "GroupTestParticipant_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."GroupTestParticipant" DROP CONSTRAINT "GroupTestParticipant_userTestInstanceId_fkey";

-- DropForeignKey
ALTER TABLE "public"."GroupTestReport" DROP CONSTRAINT "GroupTestReport_groupTestId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ScheduledGroupTestParticipant" DROP CONSTRAINT "ScheduledGroupTestParticipant_scheduledGroupTestId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ScheduledGroupTestParticipant" DROP CONSTRAINT "ScheduledGroupTestParticipant_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ScheduledGroupTestParticipant" DROP CONSTRAINT "ScheduledGroupTestParticipant_userTestInstanceId_fkey";

-- AlterTable
ALTER TABLE "public"."UserTestInstanceSummary" ADD COLUMN     "scheduledGroupTestId" TEXT;

-- DropTable
DROP TABLE "public"."GroupTest";

-- DropTable
DROP TABLE "public"."GroupTestParticipant";

-- DropTable
DROP TABLE "public"."GroupTestReport";

-- DropTable
DROP TABLE "public"."ScheduledGroupTestParticipant";

-- AddForeignKey
ALTER TABLE "public"."UserTestInstanceSummary" ADD CONSTRAINT "UserTestInstanceSummary_scheduledGroupTestId_fkey" FOREIGN KEY ("scheduledGroupTestId") REFERENCES "public"."ScheduledGroupTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionReply" ADD CONSTRAINT "DiscussionReply_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."DiscussionReply"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
