// routes/pyqRoutes.js
const express = require("express");
const router = express.Router();
const pyqController = require("../controllers/pyqController");

// Get available exam years for a specific exam
router.get("/exams/:examId/years", pyqController.getAvailableExamYears);

// Generate PYQ test
router.post("/generate-pyq-test", pyqController.generatePYQTest);

// Get PYQ test details
router.get("/tests/:testId", pyqController.getPYQTestDetails);

// Submit PYQ test
router.post("/tests/:testId/submit", pyqController.submitPYQTest);

module.exports = router;

// controllers/pyqController.js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const pyqController = {
  // Get available exam years and shifts for a specific exam
  async getAvailableExamYears(req, res) {
    try {
      const { examId } = req.params;

      // Verify exam exists
      const exam = await prisma.exam.findUnique({
        where: { id: parseInt(examId) },
      });

      if (!exam) {
        return res.status(404).json({
          success: false,
          message: "Exam not found",
        });
      }

      // Get distinct exam years and shifts from questions
      const examYears = await prisma.question.findMany({
        where: {
          subtopic: {
            topic: {
              subject: {
                examId: parseInt(examId),
              },
            },
          },
        },
        select: {
          examname: true,
        },
        distinct: ["examname"],
      });

      // Parse and organize exam years
      const organizedYears = {};

      examYears.forEach(({ examname }) => {
        // Parse examname like "JEE Main 2024 - 27th Jan Shift 1"
        const match = examname.match(/(\w+\s+\w+)\s+(\d{4})\s*-\s*(.+)/);
        if (match) {
          const [, examType, year, shift] = match;

          if (!organizedYears[year]) {
            organizedYears[year] = [];
          }

          organizedYears[year].push({
            examname,
            shift: shift.trim(),
          });
        }
      });

      // Sort years in descending order
      const sortedYears = Object.keys(organizedYears)
        .sort((a, b) => parseInt(b) - parseInt(a))
        .reduce((acc, year) => {
          acc[year] = organizedYears[year].sort((a, b) =>
            a.shift.localeCompare(b.shift)
          );
          return acc;
        }, {});

      res.json({
        success: true,
        data: {
          examId: parseInt(examId),
          examName: exam.name,
          availableYears: sortedYears,
          totalYears: Object.keys(sortedYears).length,
        },
      });
    } catch (error) {
      console.error("Error fetching exam years:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  // Submit PYQ test
  async submitPYQTest(req, res) {
    try {
      const { testId } = req.params;
      const { answers, totalTimeTaken, isAutoSubmit = false } = req.body;

      // Validate required fields
      if (!answers || !Array.isArray(answers) || !totalTimeTaken) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields: answers array and totalTimeTaken",
        });
      }

      // Get test instance with questions
      const testInstance = await prisma.userTestInstanceSummary.findUnique({
        where: { id: testId },
        include: {
          answers: {
            include: {
              question: true,
            },
          },
        },
      });

      if (!testInstance) {
        return res.status(404).json({
          success: false,
          message: "Test not found",
        });
      }

      // Check if test is already completed
      if (testInstance.numUnattempted === 0 && testInstance.score > 0) {
        return res.status(400).json({
          success: false,
          message: "Test has already been submitted",
        });
      }

      let totalScore = 0;
      let correctCount = 0;
      let incorrectCount = 0;
      let unattemptedCount = 0;

      const marksPerQuestion = 4; // Standard marking scheme
      const negativeMark = -1;

      // Process each answer and update performance data
      const performanceUpdates = {};

      await prisma.$transaction(async (tx) => {
        // Update each answer
        for (const answerData of answers) {
          const { questionId, userAnswer, timeTakenSec } = answerData;

          // Find the corresponding test answer and question
          const testAnswer = testInstance.answers.find(
            (a) => a.questionId === parseInt(questionId)
          );
          if (!testAnswer) continue;

          const question = testAnswer.question;
          let isCorrect = false;
          let status = "Unattempted";

          if (userAnswer && userAnswer.trim() !== "") {
            isCorrect =
              userAnswer.trim().toUpperCase() ===
              question.correctOption.trim().toUpperCase();
            status = isCorrect ? "Correct" : "Incorrect";

            if (isCorrect) {
              correctCount++;
              totalScore += marksPerQuestion;
            } else {
              incorrectCount++;
              totalScore += negativeMark; // Negative marking
            }
          } else {
            unattemptedCount++;
          }

          // Update the test answer
          await tx.userTestAnswer.update({
            where: { id: testAnswer.id },
            data: {
              userAnswer: userAnswer || null,
              isCorrect,
              status,
              timeTakenSec: timeTakenSec || 0,
            },
          });

          // Prepare subtopic performance update
          const subtopicId = question.subtopicId;
          if (!performanceUpdates[subtopicId]) {
            performanceUpdates[subtopicId] = {
              attempted: 0,
              correct: 0,
              incorrect: 0,
              totalTime: 0,
            };
          }

          if (status !== "Unattempted") {
            performanceUpdates[subtopicId].attempted++;
            performanceUpdates[subtopicId].totalTime += timeTakenSec || 0;

            if (status === "Correct") {
              performanceUpdates[subtopicId].correct++;
            } else {
              performanceUpdates[subtopicId].incorrect++;
            }
          }
        }

        // Calculate percentile (simplified - you might want a more sophisticated calculation)
        const percentile = calculatePercentile(
          totalScore,
          testInstance.totalMarks
        );

        // Update test instance summary
        await tx.userTestInstanceSummary.update({
          where: { id: testId },
          data: {
            score: Math.max(0, totalScore), // Ensure score doesn't go negative
            percentile,
            numCorrect: correctCount,
            numIncorrect: incorrectCount,
            numUnattempted: unattemptedCount,
            timeTakenSec: totalTimeTaken,
            completedAt: new Date(),
          },
        });

        // Update user subtopic performance
        for (const [subtopicId, perf] of Object.entries(performanceUpdates)) {
          await tx.userSubtopicPerformance.upsert({
            where: {
              userId_subtopicId: {
                userId: testInstance.userId,
                subtopicId: parseInt(subtopicId),
              },
            },
            update: {
              totalAttempted: { increment: perf.attempted },
              totalCorrect: { increment: perf.correct },
              totalIncorrect: { increment: perf.incorrect },
              totalTimeTakenSec: { increment: perf.totalTime },
            },
            create: {
              userId: testInstance.userId,
              subtopicId: parseInt(subtopicId),
              totalAttempted: perf.attempted,
              totalCorrect: perf.correct,
              totalIncorrect: perf.incorrect,
              totalTimeTakenSec: perf.totalTime,
            },
          });

          // Update derived fields
          const updatedPerformance =
            await tx.userSubtopicPerformance.findUnique({
              where: {
                userId_subtopicId: {
                  userId: testInstance.userId,
                  subtopicId: parseInt(subtopicId),
                },
              },
            });

          if (updatedPerformance) {
            const accuracyPercent =
              updatedPerformance.totalAttempted > 0
                ? (updatedPerformance.totalCorrect /
                    updatedPerformance.totalAttempted) *
                  100
                : 0;

            const avgTimePerQuestion =
              updatedPerformance.totalAttempted > 0
                ? updatedPerformance.totalTimeTakenSec /
                  updatedPerformance.totalAttempted
                : 0;

            await tx.userSubtopicPerformance.update({
              where: {
                userId_subtopicId: {
                  userId: testInstance.userId,
                  subtopicId: parseInt(subtopicId),
                },
              },
              data: {
                accuracyPercent: accuracyPercent.toFixed(2),
                avgTimePerQuestionSec: avgTimePerQuestion.toFixed(2),
              },
            });
          }
        }

        // Update overall exam summary
        const examId = await getExamIdFromTest(testInstance.userId);
        if (examId) {
          await tx.userExamOverallSummary.upsert({
            where: {
              userId_examId: {
                userId: testInstance.userId,
                examId,
              },
            },
            update: {
              totalQuestionsAttempted: {
                increment: correctCount + incorrectCount,
              },
              totalCorrect: { increment: correctCount },
              totalIncorrect: { increment: incorrectCount },
              totalMockTestsCompleted: {
                increment: testInstance.testType === "pyq" ? 1 : 0,
              },
            },
            create: {
              userId: testInstance.userId,
              examId,
              totalQuestionsAttempted: correctCount + incorrectCount,
              totalCorrect: correctCount,
              totalIncorrect: incorrectCount,
              totalMockTestsCompleted: testInstance.testType === "pyq" ? 1 : 0,
            },
          });

          // Update overall accuracy
          const examSummary = await tx.userExamOverallSummary.findUnique({
            where: {
              userId_examId: {
                userId: testInstance.userId,
                examId,
              },
            },
          });

          if (examSummary) {
            const overallAccuracy =
              examSummary.totalQuestionsAttempted > 0
                ? (examSummary.totalCorrect /
                    examSummary.totalQuestionsAttempted) *
                  100
                : 0;

            await tx.userExamOverallSummary.update({
              where: {
                userId_examId: {
                  userId: testInstance.userId,
                  examId,
                },
              },
              data: {
                overallAccuracyPercent: overallAccuracy.toFixed(2),
              },
            });
          }
        }
      });

      // Prepare detailed response
      const submissionResult = {
        testId,
        submitted: true,
        isAutoSubmit,
        results: {
          score: Math.max(0, totalScore),
          totalMarks: testInstance.totalMarks,
          percentile: calculatePercentile(totalScore, testInstance.totalMarks),
          accuracy: (
            (correctCount / (correctCount + incorrectCount)) *
            100
          ).toFixed(2),
          totalQuestions: testInstance.totalQuestions,
          correct: correctCount,
          incorrect: incorrectCount,
          unattempted: unattemptedCount,
          timeTaken: totalTimeTaken,
          timeTakenFormatted: formatTime(totalTimeTaken),
        },
        performance: {
          strongAreas: await getStrongAreas(testInstance.userId),
          weakAreas: await getWeakAreas(testInstance.userId),
          recommendedTopics: await getRecommendedTopics(testInstance.userId),
        },
        nextSteps: generateNextSteps(
          correctCount,
          incorrectCount,
          unattemptedCount,
          totalScore
        ),
      };

      res.json({
        success: true,
        message: "Test submitted successfully",
        data: submissionResult,
      });
    } catch (error) {
      console.error("Error submitting PYQ test:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  // Generate PYQ test
  async generatePYQTest(req, res) {
    try {
      const {
        userId,
        examId,
        selectedYears, // Array of specific exam names or year ranges
        questionsPerSubject,
        totalQuestions,
        difficultyDistribution = { Easy: 30, Medium: 50, Hard: 20 }, // Percentage
        testName,
      } = req.body;

      // Validate required fields
      if (!userId || !examId || (!selectedYears?.length && !totalQuestions)) {
        return res.status(400).json({
          success: false,
          message:
            "Missing required fields: userId, examId, and either selectedYears or totalQuestions",
        });
      }

      // Verify user and exam exist
      const [user, exam] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId } }),
        prisma.exam.findUnique({
          where: { id: parseInt(examId) },
          include: { subjects: true },
        }),
      ]);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      if (!exam) {
        return res.status(404).json({
          success: false,
          message: "Exam not found",
        });
      }

      // Build question filter based on selected years
      let examNameFilter = {};
      if (selectedYears && selectedYears.length > 0) {
        examNameFilter = {
          examname: {
            in: selectedYears,
          },
        };
      }

      // Get questions for each subject
      const subjectQuestions = {};

      for (const subject of exam.subjects) {
        const baseQuery = {
          where: {
            subtopic: {
              topic: {
                subject: {
                  id: subject.id,
                },
              },
            },
            ...examNameFilter,
          },
          include: {
            subtopic: {
              include: {
                topic: {
                  include: {
                    subject: true,
                  },
                },
              },
            },
          },
        };

        // Get questions by difficulty if distribution is specified
        if (questionsPerSubject && questionsPerSubject[subject.name]) {
          const targetCount = questionsPerSubject[subject.name];
          const questionsByDifficulty = {};

          // Calculate target count per difficulty
          const difficultyTargets = {
            Easy: Math.round((targetCount * difficultyDistribution.Easy) / 100),
            Medium: Math.round(
              (targetCount * difficultyDistribution.Medium) / 100
            ),
            Hard: Math.round((targetCount * difficultyDistribution.Hard) / 100),
          };

          // Fetch questions for each difficulty
          for (const [difficulty, count] of Object.entries(difficultyTargets)) {
            if (count > 0) {
              const questions = await prisma.question.findMany({
                ...baseQuery,
                where: {
                  ...baseQuery.where,
                  humanDifficultyLevel: difficulty,
                },
                take: count,
                orderBy: {
                  id: "asc", // You might want to randomize this
                },
              });
              questionsByDifficulty[difficulty] = questions;
            }
          }

          subjectQuestions[subject.name] = Object.values(
            questionsByDifficulty
          ).flat();
        } else {
          // If no specific distribution, get questions normally
          const questions = await prisma.question.findMany({
            ...baseQuery,
            take: totalQuestions
              ? Math.floor(totalQuestions / exam.subjects.length)
              : undefined,
          });
          subjectQuestions[subject.name] = questions;
        }
      }

      // Flatten all questions
      const allQuestions = Object.values(subjectQuestions).flat();

      if (allQuestions.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No questions found for the selected criteria",
        });
      }

      // Limit to total questions if specified
      const finalQuestions = totalQuestions
        ? allQuestions.slice(0, totalQuestions)
        : allQuestions;

      // Calculate test parameters (similar to actual exam format)
      const testParameters = calculateTestParameters(
        exam.name,
        finalQuestions.length
      );

      // Create test instance
      const testInstance = await prisma.userTestInstanceSummary.create({
        data: {
          userId,
          testName:
            testName ||
            `PYQ Test - ${exam.name} (${
              selectedYears?.join(", ") || "Mixed Years"
            })`,
          testType: "pyq",
          score: 0, // Will be updated when test is completed
          totalMarks: testParameters.totalMarks,
          totalQuestions: finalQuestions.length,
          numCorrect: 0,
          numIncorrect: 0,
          numUnattempted: finalQuestions.length,
          timeTakenSec: 0,
        },
      });

      // Create test answers (initially unattempted)
      const testAnswers = await prisma.userTestAnswer.createMany({
        data: finalQuestions.map((question, index) => ({
          testInstanceId: testInstance.id,
          questionId: question.id,
          userId,
          userAnswer: null,
          isCorrect: false,
          status: "Unattempted",
          timeTakenSec: 0,
        })),
      });

      // Prepare response data
      const testData = {
        testId: testInstance.id,
        testName: testInstance.testName,
        totalQuestions: finalQuestions.length,
        totalMarks: testParameters.totalMarks,
        timeLimit: testParameters.timeLimit,
        subjects: Object.keys(subjectQuestions).map((subjectName) => ({
          name: subjectName,
          questionCount: subjectQuestions[subjectName].length,
        })),
        questions: finalQuestions.map((q, index) => ({
          id: q.id,
          questionNumber: index + 1,
          question: q.question,
          options: q.options,
          imageUrl: q.imageUrl,
          subject: q.subtopic.topic.subject.name,
          topic: q.subtopic.topic.name,
          subtopic: q.subtopic.name,
          examSource: q.examname,
          difficultyLevel: q.humanDifficultyLevel,
          averageTime: q.averageTimeSec,
        })),
        examYearsSummary: getExamYearsSummary(finalQuestions),
      };

      res.json({
        success: true,
        message: "PYQ test generated successfully",
        data: testData,
      });
    } catch (error) {
      console.error("Error generating PYQ test:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  // Get PYQ test details
  async getPYQTestDetails(req, res) {
    try {
      const { testId } = req.params;

      const testInstance = await prisma.userTestInstanceSummary.findUnique({
        where: { id: testId },
        include: {
          answers: {
            include: {
              question: {
                include: {
                  subtopic: {
                    include: {
                      topic: {
                        include: {
                          subject: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
            },
          },
        },
      });

      if (!testInstance) {
        return res.status(404).json({
          success: false,
          message: "Test not found",
        });
      }

      // Process test details
      const testDetails = {
        testId: testInstance.id,
        testName: testInstance.testName,
        testType: testInstance.testType,
        user: testInstance.user,
        score: testInstance.score,
        totalMarks: testInstance.totalMarks,
        percentile: testInstance.percentile,
        totalQuestions: testInstance.totalQuestions,
        numCorrect: testInstance.numCorrect,
        numIncorrect: testInstance.numIncorrect,
        numUnattempted: testInstance.numUnattempted,
        timeTakenSec: testInstance.timeTakenSec,
        completedAt: testInstance.completedAt,
        questions: testInstance.answers.map((answer) => ({
          questionId: answer.question.id,
          question: answer.question.question,
          options: answer.question.options,
          correctOption: answer.question.correctOption,
          userAnswer: answer.userAnswer,
          isCorrect: answer.isCorrect,
          status: answer.status,
          timeTaken: answer.timeTakenSec,
          solution: answer.question.solution,
          imageUrl: answer.question.imageUrl,
          subject: answer.question.subtopic.topic.subject.name,
          topic: answer.question.subtopic.topic.name,
          subtopic: answer.question.subtopic.name,
          examSource: answer.question.examname,
          difficultyLevel: answer.question.humanDifficultyLevel,
        })),
        subjectWiseAnalysis: getSubjectWiseAnalysis(testInstance.answers),
      };

      res.json({
        success: true,
        data: testDetails,
      });
    } catch (error) {
      console.error("Error fetching PYQ test details:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },
};

// Helper functions
function calculateTestParameters(examName, questionCount) {
  // Default parameters - adjust based on actual exam format
  const baseMarksPerQuestion = 4;
  const baseTimePerQuestion = 180; // 3 minutes per question in seconds

  return {
    totalMarks: questionCount * baseMarksPerQuestion,
    timeLimit: questionCount * baseTimePerQuestion, // in seconds
    negativeMarking: -1, // -1 mark for incorrect answer
  };
}

function getExamYearsSummary(questions) {
  const yearCounts = {};

  questions.forEach((question) => {
    const examname = question.examname;
    if (!yearCounts[examname]) {
      yearCounts[examname] = 0;
    }
    yearCounts[examname]++;
  });

  return Object.entries(yearCounts)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([examname, count]) => ({ examname, questionCount: count }));
}

function getSubjectWiseAnalysis(answers) {
  const subjectStats = {};

  answers.forEach((answer) => {
    const subjectName = answer.question.subtopic.topic.subject.name;

    if (!subjectStats[subjectName]) {
      subjectStats[subjectName] = {
        total: 0,
        correct: 0,
        incorrect: 0,
        unattempted: 0,
        totalTime: 0,
      };
    }

    subjectStats[subjectName].total++;
    subjectStats[subjectName].totalTime += answer.timeTakenSec;

    if (answer.status === "Correct") {
      subjectStats[subjectName].correct++;
    } else if (answer.status === "Incorrect") {
      subjectStats[subjectName].incorrect++;
    } else {
      subjectStats[subjectName].unattempted++;
    }
  });

  // Calculate percentages and averages
  Object.keys(subjectStats).forEach((subject) => {
    const stats = subjectStats[subject];
    stats.accuracy =
      stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(2) : 0;
    stats.averageTime =
      stats.total > 0 ? (stats.totalTime / stats.total).toFixed(0) : 0;
  });

  return subjectStats;
}

function calculatePercentile(score, totalMarks) {
  // Simplified percentile calculation
  // In a real application, you'd compare against historical data
  const percentage = (score / totalMarks) * 100;

  if (percentage >= 95) return 99.5;
  if (percentage >= 90) return 95.0;
  if (percentage >= 85) return 90.0;
  if (percentage >= 80) return 85.0;
  if (percentage >= 75) return 80.0;
  if (percentage >= 70) return 75.0;
  if (percentage >= 60) return 65.0;
  if (percentage >= 50) return 50.0;
  if (percentage >= 40) return 35.0;
  if (percentage >= 30) return 25.0;
  return Math.max(1, percentage * 0.5);
}

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${remainingSeconds}s`;
  }
}

async function getExamIdFromTest(userId) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { primaryExamId: true },
    });
    return user?.primaryExamId || null;
  } catch (error) {
    console.error("Error getting exam ID:", error);
    return null;
  }
}

async function getStrongAreas(userId) {
  try {
    const strongAreas = await prisma.userSubtopicPerformance.findMany({
      where: {
        userId,
        accuracyPercent: { gte: 80 },
        totalAttempted: { gte: 5 },
      },
      include: {
        subtopic: {
          include: {
            topic: {
              include: {
                subject: true,
              },
            },
          },
        },
      },
      orderBy: {
        accuracyPercent: "desc",
      },
      take: 5,
    });

    return strongAreas.map((area) => ({
      subject: area.subtopic.topic.subject.name,
      topic: area.subtopic.topic.name,
      subtopic: area.subtopic.name,
      accuracy: parseFloat(area.accuracyPercent),
      questionsAttempted: area.totalAttempted,
    }));
  } catch (error) {
    console.error("Error getting strong areas:", error);
    return [];
  }
}

async function getWeakAreas(userId) {
  try {
    const weakAreas = await prisma.userSubtopicPerformance.findMany({
      where: {
        userId,
        accuracyPercent: { lt: 60 },
        totalAttempted: { gte: 3 },
      },
      include: {
        subtopic: {
          include: {
            topic: {
              include: {
                subject: true,
              },
            },
          },
        },
      },
      orderBy: {
        accuracyPercent: "asc",
      },
      take: 5,
    });

    return weakAreas.map((area) => ({
      subject: area.subtopic.topic.subject.name,
      topic: area.subtopic.topic.name,
      subtopic: area.subtopic.name,
      accuracy: parseFloat(area.accuracyPercent),
      questionsAttempted: area.totalAttempted,
    }));
  } catch (error) {
    console.error("Error getting weak areas:", error);
    return [];
  }
}

async function getRecommendedTopics(userId) {
  try {
    // Get topics with low accuracy or never attempted
    const recommendedTopics = await prisma.userSubtopicPerformance.findMany({
      where: {
        userId,
        OR: [{ accuracyPercent: { lt: 70 } }, { totalAttempted: { lt: 3 } }],
      },
      include: {
        subtopic: {
          include: {
            topic: {
              include: {
                subject: true,
              },
            },
          },
        },
      },
      orderBy: [{ totalAttempted: "asc" }, { accuracyPercent: "asc" }],
      take: 8,
    });

    return recommendedTopics.map((topic) => ({
      subject: topic.subtopic.topic.subject.name,
      topic: topic.subtopic.topic.name,
      subtopic: topic.subtopic.name,
      reason: topic.totalAttempted < 3 ? "Need more practice" : "Low accuracy",
      accuracy: parseFloat(topic.accuracyPercent),
      questionsAttempted: topic.totalAttempted,
    }));
  } catch (error) {
    console.error("Error getting recommended topics:", error);
    return [];
  }
}

function generateNextSteps(correct, incorrect, unattempted, score) {
  const steps = [];

  if (unattempted > 5) {
    steps.push({
      type: "time_management",
      title: "Improve Time Management",
      description: `You left ${unattempted} questions unattempted. Focus on time management strategies.`,
      priority: "high",
    });
  }

  if (incorrect > correct) {
    steps.push({
      type: "accuracy",
      title: "Focus on Accuracy",
      description:
        "Work on understanding concepts better before attempting speed.",
      priority: "high",
    });
  }

  if (score < 0) {
    steps.push({
      type: "negative_marking",
      title: "Avoid Negative Marking",
      description:
        "Be more careful with guessing. Skip if unsure rather than guessing randomly.",
      priority: "medium",
    });
  }

  steps.push({
    type: "practice",
    title: "Regular Practice",
    description:
      "Take more PYQ tests to improve your performance consistently.",
    priority: "medium",
  });

  return steps;
}

module.exports = pyqController;
