import { prisma } from "../services/db.js";
import questionsJson from "./questions.json" with { type: "json" };

// 👇 Hardcode the examId
const EXAM_ID = 1;

async function getExamSessionOrCreate(sessionName: string) {
  // Upsert the exam session with examId = 1
  const examSession = await prisma.examSession.upsert({
    where: { examId_name: { examId: EXAM_ID, name: sessionName } },
    update: {},
    create: {
      examId: EXAM_ID,
      name: sessionName,
      sessionDate: null, // optional, you can populate if you have date
    },
  });

  console.log(`Ensured exam session '${sessionName}' exists with ID: ${examSession.id}`);
  return examSession.id;
}

async function main() {
  console.log("📥 Starting import...");

  const questions = questionsJson as any[];

  for (const q of questions) {
    // 🔑 Get or create ExamSession (instead of exam)
    const examSessionId = await getExamSessionOrCreate(q.examname);

    // ✅ Ensure subject
    const subject = await prisma.subject.upsert({
      where: { examId_name: { examId: EXAM_ID, name: q.subject } },
      update: {},
      create: { examId: EXAM_ID, name: q.subject },
    });

    // ✅ Ensure topic
    const topic = await prisma.topic.upsert({
      where: { subjectId_name: { subjectId: subject.id, name: q.topic } },
      update: {},
      create: { subjectId: subject.id, name: q.topic },
    });

    // ✅ Ensure subtopic
    const primarySubtopic = q.subtopics?.[0] || "Uncategorized";
    const subtopic = await prisma.subtopic.upsert({
      where: { topicId_name: { topicId: topic.id, name: primarySubtopic } },
      update: {},
      create: { topicId: topic.id, name: primarySubtopic },
    });

    // ✅ Create question linked to examSession + subtopic
    await prisma.question.create({
      data: {
        subtopicId: subtopic.id,
        examSessionId,
        question: q.question,
        shortcut: q.shortcut || null,
        equations: q.equation || null,
        imageUrl: q.imageurl || null,
        imagesolurl: q.imagesolurl || null,
        options: q.options || null,
        correctOption: q.correct_option,
        solution: q.solution,
        humanDifficultyLevel: q.difficulty_level as any, // matches enum
        questionType: q.question_type || [],
        averageTimeSec: q.avg_time_to_solve || null,
      },
    });

    console.log(`✅ Added: ${q.question.substring(0, 50)}...`);
  }

  console.log("🎉 Import completed!");
}

main()
  .catch((err) => {
    console.error("❌ Error importing questions:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
