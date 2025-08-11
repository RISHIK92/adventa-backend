/*
  Warnings:

  - Added the required column `durationInMinutes` to the `Exam` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalQuestions` to the `Exam` table without a default value. This is not possible if the table is not empty.
  - Added the required column `examId` to the `UserTestInstanceSummary` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."Exam" ADD COLUMN     "durationInMinutes" INTEGER NOT NULL,
ADD COLUMN     "marksPerCorrect" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "marksPerUnattempted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "negativeMarksPerIncorrect" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "totalQuestions" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."UserTestInstanceSummary" ADD COLUMN     "examId" INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."UserTestInstanceSummary" ADD CONSTRAINT "UserTestInstanceSummary_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
