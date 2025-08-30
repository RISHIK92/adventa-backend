-- DropForeignKey
ALTER TABLE "public"."UserTestInstanceSummary" DROP CONSTRAINT "UserTestInstanceSummary_examId_fkey";

-- AlterTable
ALTER TABLE "public"."UserTestInstanceSummary" ALTER COLUMN "examId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."UserTestInstanceSummary" ADD CONSTRAINT "UserTestInstanceSummary_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;
