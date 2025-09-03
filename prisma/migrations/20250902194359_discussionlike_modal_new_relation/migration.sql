/*
  Warnings:

  - The primary key for the `DiscussionLike` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - A unique constraint covering the columns `[userId,replyId]` on the table `DiscussionLike` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,threadId]` on the table `DiscussionLike` will be added. If there are existing duplicate values, this will fail.
  - The required column `id` was added to the `DiscussionLike` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- DropForeignKey
ALTER TABLE "public"."DiscussionLike" DROP CONSTRAINT "DiscussionLike_userId_fkey";

-- AlterTable
ALTER TABLE "public"."DiscussionLike" DROP CONSTRAINT "DiscussionLike_pkey",
ADD COLUMN     "id" TEXT NOT NULL,
ADD COLUMN     "threadId" TEXT,
ALTER COLUMN "replyId" DROP NOT NULL,
ADD CONSTRAINT "DiscussionLike_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE UNIQUE INDEX "DiscussionLike_userId_replyId_key" ON "public"."DiscussionLike"("userId", "replyId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscussionLike_userId_threadId_key" ON "public"."DiscussionLike"("userId", "threadId");

-- AddForeignKey
ALTER TABLE "public"."DiscussionLike" ADD CONSTRAINT "DiscussionLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionLike" ADD CONSTRAINT "DiscussionLike_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."DiscussionThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
