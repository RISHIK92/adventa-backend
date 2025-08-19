-- CreateTable
CREATE TABLE "public"."GeneratedPyqPaper" (
    "id" SERIAL NOT NULL,
    "examSessionId" INTEGER NOT NULL,
    "questionOrder" JSONB NOT NULL,

    CONSTRAINT "GeneratedPyqPaper_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedPyqPaper_examSessionId_key" ON "public"."GeneratedPyqPaper"("examSessionId");

-- AddForeignKey
ALTER TABLE "public"."GeneratedPyqPaper" ADD CONSTRAINT "GeneratedPyqPaper_examSessionId_fkey" FOREIGN KEY ("examSessionId") REFERENCES "public"."ExamSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
