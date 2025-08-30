/*
  Warnings:

  - A unique constraint covering the columns `[userTestInstanceId]` on the table `ChallengeParticipant` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."ChallengeParticipant" ADD COLUMN     "userTestInstanceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeParticipant_userTestInstanceId_key" ON "public"."ChallengeParticipant"("userTestInstanceId");

-- AddForeignKey
ALTER TABLE "public"."ChallengeParticipant" ADD CONSTRAINT "ChallengeParticipant_userTestInstanceId_fkey" FOREIGN KEY ("userTestInstanceId") REFERENCES "public"."UserTestInstanceSummary"("id") ON DELETE SET NULL ON UPDATE CASCADE;
