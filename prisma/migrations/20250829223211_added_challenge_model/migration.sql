/*
  Warnings:

  - Added the required column `difficulty` to the `Challenge` table without a default value. This is not possible if the table is not empty.
  - Added the required column `timeLimit` to the `Challenge` table without a default value. This is not possible if the table is not empty.
  - Added the required column `title` to the `Challenge` table without a default value. This is not possible if the table is not empty.
  - Added the required column `topicId` to the `Challenge` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "public"."Challenge" DROP CONSTRAINT "Challenge_challengedId_fkey";

-- AlterTable
ALTER TABLE "public"."Challenge" ADD COLUMN     "difficulty" "public"."DifficultyLevel" NOT NULL,
ADD COLUMN     "timeLimit" INTEGER NOT NULL,
ADD COLUMN     "title" TEXT NOT NULL,
ADD COLUMN     "topicId" INTEGER NOT NULL,
ALTER COLUMN "challengedId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."Challenge" ADD CONSTRAINT "Challenge_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "public"."Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challenge" ADD CONSTRAINT "Challenge_challengedId_fkey" FOREIGN KEY ("challengedId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
