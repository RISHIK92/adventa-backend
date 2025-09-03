import { prisma } from "../services/db.js";
import fs from "fs";
import JSON5 from "json5";

// 👇 Hardcode the examId
const EXAM_ID = 1;

function loadQuestions() {
  const rawFileContent = fs.readFileSync("src/utils/questions.json", "utf8");
  try {
    return JSON5.parse(rawFileContent);
  } catch (error: any) {
    console.error(
      "❌ FATAL: The file 'src/utils/questions.jsonl' contains a JSON syntax error and cannot be parsed."
    );
    console.error(`   Parser Error: ${error.message}`);
    process.exit(1);
  }
}

async function getExamSessionOrCreate(sessionName: string) {
  const examSession = await prisma.examSession.upsert({
    where: { examId_name: { examId: EXAM_ID, name: sessionName } },
    update: {},
    create: {
      examId: EXAM_ID,
      name: sessionName,
      sessionDate: null,
    },
  });
  console.log(
    `Ensured exam session '${sessionName}' exists with ID: ${examSession.id}`
  );
  return examSession.id;
}

async function main() {
  console.log("📥 Starting import...");

  const questions = loadQuestions();

  for (const q of questions) {
    try {
      const examSessionId = await getExamSessionOrCreate(q.examname);

      const subject = await prisma.subject.upsert({
        where: { examId_name: { examId: EXAM_ID, name: q.subject } },
        update: {},
        create: { examId: EXAM_ID, name: q.subject },
      });

      const topic = await prisma.topic.upsert({
        where: { subjectId_name: { subjectId: subject.id, name: q.topic } },
        update: {},
        create: { subjectId: subject.id, name: q.topic },
      });

      const primarySubtopic = q.subtopics?.[0] || "Uncategorized";
      const subtopic = await prisma.subtopic.upsert({
        where: { topicId_name: { topicId: topic.id, name: primarySubtopic } },
        update: {},
        create: { topicId: topic.id, name: primarySubtopic },
      });

      // ✅ THIS BLOCK IS NOW FULLY CORRECTED
      await prisma.question.create({
        data: {
          subtopic: {
            connect: {
              id: subtopic.id,
            },
          },
          examSession: {
            connect: {
              id: examSessionId,
            },
          },
          question: q.question,
          shortcut: q.shortcut || null,
          equations: q.equation || null,
          imageUrl: q.imageurl || null,
          imagesolurl: q.imagesolurl || null,
          options: q.options || null,
          correctOption: q.correct_option,
          solution: q.solution,
          humanDifficultyLevel: q.difficulty_level as any,
          questionType: q.question_type || [],
          averageTimeSec: q.avg_time_to_solve || null,
        },
      });

      console.log(`✅ Added: ${q.question.substring(0, 50)}...`);
    } catch (dbError: any) {
      console.error(
        `❌ Failed to import question ID ${
          q.id || "(unknown)"
        } into the database. Error: ${dbError.message}`
      );
    }
  }

  console.log("🎉 Import completed!");
}

main()
  .catch((err) => {
    console.error("❌ A critical error occurred in the main process:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
