/*
  Warnings:

  - You are about to drop the column `examname` on the `Question` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."Question" DROP COLUMN "examname",
ADD COLUMN     "examSessionId" INTEGER;

-- CreateTable
CREATE TABLE "public"."ExamSession" (
    "id" SERIAL NOT NULL,
    "examId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sessionDate" TIMESTAMP(3),

    CONSTRAINT "ExamSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExamSession_examId_name_key" ON "public"."ExamSession"("examId", "name");

-- AddForeignKey
ALTER TABLE "public"."ExamSession" ADD CONSTRAINT "ExamSession_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Question" ADD CONSTRAINT "Question_examSessionId_fkey" FOREIGN KEY ("examSessionId") REFERENCES "public"."ExamSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
