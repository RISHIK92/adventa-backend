-- AlterTable
ALTER TABLE "public"."ChallengeParticipant" ADD COLUMN     "hasCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "numCorrect" INTEGER,
ADD COLUMN     "numIncorrect" INTEGER,
ADD COLUMN     "numUnattempted" INTEGER,
ADD COLUMN     "score" INTEGER,
ADD COLUMN     "timeTakenSec" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "public"."ChallengeAnswer" (
    "id" SERIAL NOT NULL,
    "challengeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" INTEGER NOT NULL,
    "userAnswer" TEXT,
    "timeTakenSec" DOUBLE PRECISION NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,

    CONSTRAINT "ChallengeAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeAnswer_challengeId_userId_questionId_key" ON "public"."ChallengeAnswer"("challengeId", "userId", "questionId");

-- AddForeignKey
ALTER TABLE "public"."ChallengeAnswer" ADD CONSTRAINT "ChallengeAnswer_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "public"."Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChallengeAnswer" ADD CONSTRAINT "ChallengeAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChallengeAnswer" ADD CONSTRAINT "ChallengeAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
