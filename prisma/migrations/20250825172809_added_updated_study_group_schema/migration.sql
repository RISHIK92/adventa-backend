-- CreateEnum
CREATE TYPE "public"."ChallengeStatus" AS ENUM ('PENDING_ACCEPTANCE', 'ACCEPTED', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."StudyRoomPrivacy" AS ENUM ('PUBLIC', 'PRIVATE', 'INVITE_ONLY');

-- CreateEnum
CREATE TYPE "public"."InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "public"."GroupTest" ADD COLUMN     "isContestMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lateJoinWindowMinutes" INTEGER DEFAULT 5,
ADD COLUMN     "randomizeQuestions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "startTime" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."GroupTestParticipant" ADD COLUMN     "predictedConfidence" INTEGER,
ADD COLUMN     "predictedScore" INTEGER;

-- AlterTable
ALTER TABLE "public"."StudyRoom" ADD COLUMN     "averageRating" DECIMAL(2,1) DEFAULT 0.0,
ADD COLUMN     "examId" INTEGER,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "maxMembers" INTEGER,
ADD COLUMN     "memberCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "privacy" "public"."StudyRoomPrivacy" NOT NULL DEFAULT 'PUBLIC',
ADD COLUMN     "reviewCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "score" DECIMAL(10,2) DEFAULT 0.0;

-- AlterTable
ALTER TABLE "public"."StudyRoomMember" ADD COLUMN     "reputation" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."Subject" ADD COLUMN     "averageAccuracyPercent" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "score" DECIMAL(10,2) DEFAULT 0.0;

-- CreateTable
CREATE TABLE "public"."UserSubjectPerformance" (
    "userId" TEXT NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "totalAttempted" INTEGER NOT NULL DEFAULT 0,
    "totalCorrect" INTEGER NOT NULL DEFAULT 0,
    "totalIncorrect" INTEGER NOT NULL DEFAULT 0,
    "totalTimeTakenSec" INTEGER NOT NULL DEFAULT 0,
    "accuracyPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "avgTimePerQuestionSec" DECIMAL(10,2) NOT NULL DEFAULT 0.00,

    CONSTRAINT "UserSubjectPerformance_pkey" PRIMARY KEY ("userId","subjectId")
);

-- CreateTable
CREATE TABLE "public"."StudyRoomExam" (
    "studyRoomId" TEXT NOT NULL,
    "examId" INTEGER NOT NULL,

    CONSTRAINT "StudyRoomExam_pkey" PRIMARY KEY ("studyRoomId","examId")
);

-- CreateTable
CREATE TABLE "public"."StudyRoomSubject" (
    "studyRoomId" TEXT NOT NULL,
    "subjectId" INTEGER NOT NULL,

    CONSTRAINT "StudyRoomSubject_pkey" PRIMARY KEY ("studyRoomId","subjectId")
);

-- CreateTable
CREATE TABLE "public"."StudyRoomInvitation" (
    "id" TEXT NOT NULL,
    "studyRoomId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "status" "public"."InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudyRoomInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StudyRoomInvite" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "studyRoomId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "usageLimit" INTEGER,
    "usageCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StudyRoomInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StudyRoomReview" (
    "id" TEXT NOT NULL,
    "studyRoomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudyRoomReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Challenge" (
    "id" TEXT NOT NULL,
    "studyRoomId" TEXT NOT NULL,
    "challengerId" TEXT NOT NULL,
    "challengedId" TEXT NOT NULL,
    "subtopicId" INTEGER,
    "status" "public"."ChallengeStatus" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    "winnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ChallengeParticipant" (
    "challengeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "public"."ChallengeStatus" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    "predictedScore" INTEGER,
    "predictedConfidence" INTEGER,
    "finalScore" INTEGER,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ChallengeParticipant_pkey" PRIMARY KEY ("challengeId","userId")
);

-- CreateTable
CREATE TABLE "public"."DiscussionThread" (
    "id" TEXT NOT NULL,
    "studyRoomId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "questionId" INTEGER,
    "pinnedReplyId" TEXT,

    CONSTRAINT "DiscussionThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DiscussionReply" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parentId" TEXT,

    CONSTRAINT "DiscussionReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DiscussionLike" (
    "replyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "DiscussionLike_pkey" PRIMARY KEY ("replyId","userId")
);

-- CreateTable
CREATE TABLE "public"."Badge" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "iconUrl" TEXT,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserBadge" (
    "userId" TEXT NOT NULL,
    "badgeId" INTEGER NOT NULL,
    "studyRoomId" TEXT,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("userId","badgeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudyRoomInvitation_studyRoomId_inviteeId_key" ON "public"."StudyRoomInvitation"("studyRoomId", "inviteeId");

-- CreateIndex
CREATE UNIQUE INDEX "StudyRoomInvite_code_key" ON "public"."StudyRoomInvite"("code");

-- CreateIndex
CREATE UNIQUE INDEX "StudyRoomReview_studyRoomId_userId_key" ON "public"."StudyRoomReview"("studyRoomId", "userId");

-- CreateIndex
CREATE INDEX "DiscussionThread_studyRoomId_createdAt_idx" ON "public"."DiscussionThread"("studyRoomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_name_key" ON "public"."Badge"("name");

-- AddForeignKey
ALTER TABLE "public"."UserSubjectPerformance" ADD CONSTRAINT "UserSubjectPerformance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserSubjectPerformance" ADD CONSTRAINT "UserSubjectPerformance_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "public"."Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoom" ADD CONSTRAINT "StudyRoom_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomExam" ADD CONSTRAINT "StudyRoomExam_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomExam" ADD CONSTRAINT "StudyRoomExam_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomSubject" ADD CONSTRAINT "StudyRoomSubject_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomSubject" ADD CONSTRAINT "StudyRoomSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "public"."Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomInvitation" ADD CONSTRAINT "StudyRoomInvitation_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomInvitation" ADD CONSTRAINT "StudyRoomInvitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomInvitation" ADD CONSTRAINT "StudyRoomInvitation_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomInvite" ADD CONSTRAINT "StudyRoomInvite_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomReview" ADD CONSTRAINT "StudyRoomReview_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyRoomReview" ADD CONSTRAINT "StudyRoomReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challenge" ADD CONSTRAINT "Challenge_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challenge" ADD CONSTRAINT "Challenge_challengerId_fkey" FOREIGN KEY ("challengerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challenge" ADD CONSTRAINT "Challenge_challengedId_fkey" FOREIGN KEY ("challengedId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challenge" ADD CONSTRAINT "Challenge_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChallengeParticipant" ADD CONSTRAINT "ChallengeParticipant_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "public"."Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChallengeParticipant" ADD CONSTRAINT "ChallengeParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionThread" ADD CONSTRAINT "DiscussionThread_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionThread" ADD CONSTRAINT "DiscussionThread_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionThread" ADD CONSTRAINT "DiscussionThread_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionReply" ADD CONSTRAINT "DiscussionReply_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."DiscussionThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionReply" ADD CONSTRAINT "DiscussionReply_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionReply" ADD CONSTRAINT "DiscussionReply_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."DiscussionReply"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionLike" ADD CONSTRAINT "DiscussionLike_replyId_fkey" FOREIGN KEY ("replyId") REFERENCES "public"."DiscussionReply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionLike" ADD CONSTRAINT "DiscussionLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserBadge" ADD CONSTRAINT "UserBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserBadge" ADD CONSTRAINT "UserBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "public"."Badge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserBadge" ADD CONSTRAINT "UserBadge_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
