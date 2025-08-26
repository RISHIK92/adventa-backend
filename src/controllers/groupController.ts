// import type { Request, Response } from "express";
// import { prisma } from "../services/db.js";
// import { AnswerStatus, DifficultyLevel, Prisma } from "@prisma/client";
// import { z } from "zod";
// import { de } from "zod/v4/locales";
// import { redisClient } from "../config/redis.js";
// import {
//   updateGlobalTopicAverages,
//   updateGlobalSubtopicAverages,
//   updateUserOverallAverage,
// } from "../utils/globalStatsUpdater.js";

// // Zod schemas for request validation
// const createRoomSchema = z.object({
//   name: z.string().min(1),
//   description: z.string().optional(),
// });

// const addMembersSchema = z.object({
//   userIds: z.array(z.string()),
// });

// const createGroupTestSchema = z.object({
//   examId: z.number(),
//   testSettings: z.any(),
//   participantIds: z.array(z.string()),
// });

// /**
//  * ROUTE: POST /study-room/create
//  * Creates a new study room.
//  */
// export const createStudyRoom = async (req: Request, res: Response) => {
//   try {
//     const { uid } = req.user;
//     const validation = createRoomSchema.safeParse(req.body);

//     if (!uid) {
//       return res.status(401).json({ error: "User not authenticated" });
//     }

//     if (!validation.success) {
//       return res
//         .status(400)
//         .json({ errors: validation.error.flatten().fieldErrors });
//     }

//     let { name, description } = validation.data;

//     if (!description) {
//       description = "";
//     }

//     const newRoom = await prisma.studyRoom.create({
//       data: {
//         name,
//         creator: name,
//         description,
//         admins: {
//           connect: { id: uid },
//         },
//         members: {
//           create: {
//             userId: uid,
//             role: "ADMIN",
//           },
//         },
//       },
//     });

//     res.status(201).json({ success: true, data: newRoom });
//   } catch (error) {
//     console.error("Error creating study room:", error);
//     res.status(500).json({ error: "Internal server error" });
//   }
// };

// /**
//  * ROUTE: GET /study-room/:roomId
//  * Fetches details of a specific study room.
//  */
// export const getStudyRoomDetails = async (req: Request, res: Response) => {
//   try {
//     const { roomId } = req.params;

//     if (!roomId) {
//       return res.status(400).json({ error: "Room ID is required" });
//     }

//     const room = await prisma.studyRoom.findUnique({
//       where: { id: roomId },
//       include: {
//         members: {
//           include: {
//             user: {
//               select: { id: true, fullName: true, email: true },
//             },
//           },
//         },
//         groupTests: true,
//         admins: {
//           select: { id: true, fullName: true },
//         },
//       },
//     });

//     if (!room) {
//       return res.status(404).json({ error: "Study room not found" });
//     }

//     res.json({ success: true, data: room });
//   } catch (error) {
//     console.error("Error getting study room details:", error);
//     res.status(500).json({ error: "Internal server error" });
//   }
// };

// /**
//  * ROUTE: GET /study-rooms
//  * Fetches all study rooms for the authenticated user.
//  */
// export const getAllUserStudyRooms = async (req: Request, res: Response) => {
//   try {
//     const { uid } = req.user;

//     const rooms = await prisma.studyRoom.findMany({
//       where: {
//         members: {
//           some: {
//             userId: uid,
//           },
//         },
//       },
//     });

//     res.json({ success: true, data: rooms });
//   } catch (error) {
//     console.error("Error getting user study rooms:", error);
//     res.status(500).json({ error: "Internal server error" });
//   }
// };

// /**
//  * ROUTE: DELETE /study-room/:roomId
//  * Deletes a study room.
//  */
// export const deleteStudyRoom = async (req: Request, res: Response) => {
//   try {
//     const { uid } = req.user;
//     const { roomId } = req.params;

//     if (!roomId) {
//       return res.status(400).json({ error: "Room ID is required" });
//     }
//     const room = await prisma.studyRoom.findUnique({
//       where: { id: roomId },
//       include: { admins: true },
//     });

//     if (!room) {
//       return res.status(404).json({ error: "Study room not found" });
//     }

//     if (!room.admins.some((admin) => admin.id === uid)) {
//       return res.status(403).json({ error: "Only admins can delete the room" });
//     }

//     await prisma.studyRoom.delete({
//       where: { id: roomId },
//     });

//     res.json({ success: true, message: "Study room deleted successfully" });
//   } catch (error) {
//     console.error("Error deleting study room:", error);
//     res.status(500).json({ error: "Internal server error" });
//   }
// };

// /**
//  * ROUTE: POST /study-room/:roomId/members
//  * Adds members to a study room.
//  */
// export const addMembersToStudyRoom = async (req: Request, res: Response) => {
//   try {
//     const { uid } = req.user;
//     const { roomId } = req.params;
//     const validation = addMembersSchema.safeParse(req.body);

//     if (!uid) {
//       return res.status(401).json({ error: "User not authenticated" });
//     }

//     if (!roomId) {
//       return res.status(400).json({ error: "Room ID is required" });
//     }

//     if (!validation.success) {
//       return res
//         .status(400)
//         .json({ errors: validation.error.flatten().fieldErrors });
//     }

//     const { userIds } = validation.data;

//     const room = await prisma.studyRoom.findUnique({
//       where: { id: roomId },
//       include: { admins: true },
//     });

//     if (!room) {
//       return res.status(404).json({ error: "Study room not found" });
//     }

//     if (!room.admins.some((admin) => admin.id === uid)) {
//       return res.status(403).json({ error: "Only admins can add members" });
//     }

//     await prisma.studyRoomMember.createMany({
//       data: userIds.map((userId) => ({
//         studyRoomId: roomId,
//         userId: userId,
//         role: "MEMBER",
//       })),
//       skipDuplicates: true,
//     });

//     res.json({ success: true, message: "Members added successfully" });
//   } catch (error) {
//     console.error("Error adding members to study room:", error);
//     res.status(500).json({ error: "Internal server error" });
//   }
// };

// /**
//  * ROUTE: POST /study-room/:roomId/group-test
//  * Creates a group test for a study room.
//  */
// export const createGroupTest = async (req: Request, res: Response) => {
//   try {
//     const { uid } = req.user;
//     const { roomId } = req.params;
//     const validation = createGroupTestSchema.safeParse(req.body);

//     if (!validation.success) {
//       return res
//         .status(400)
//         .json({ errors: validation.error.flatten().fieldErrors });
//     }

//     if (!roomId) {
//       return res.status(400).json({ error: "Room ID is required" });
//     }

//     const { examId, testSettings, participantIds } = validation.data;

//     const room = await prisma.studyRoom.findUnique({
//       where: { id: roomId },
//       include: { admins: true },
//     });

//     if (!room) {
//       return res.status(404).json({ error: "Study room not found" });
//     }

//     if (!room.admins.some((admin) => admin.id === uid)) {
//       return res
//         .status(403)
//         .json({ error: "Only admins can create a group test" });
//     }

//     const exam = await prisma.exam.findUnique({ where: { id: examId } });
//     if (!exam) {
//       return res.status(404).json({ error: "Exam not found" });
//     }

//     const startTime = new Date();
//     const endTime = new Date(
//       startTime.getTime() + exam.durationInMinutes * 60000
//     );

//     const newGroupTest = await prisma.groupTest.create({
//       data: {
//         studyRoomId: roomId,
//         createdById: uid,
//         testSettings,
//       },
//     });

//     // For a real-world scenario, you'd use a job queue to handle the test timeout.
//     // This example assumes a mechanism is in place to close the test at `endTime`.

//     res.status(201).json({
//       success: true,
//       data: {
//         groupTestId: newGroupTest.id,
//         startTime,
//         endTime,
//       },
//     });
//   } catch (error) {
//     console.error("Error creating group test:", error);
//     res.status(500).json({ error: "Internal server error" });
//   }
// };

// /**
//  * ROUTE: POST /group-test/:groupTestId/submit
//  */
// export const submitGroupTest = async (req: Request, res: Response) => {
//   try {
//     const { uid } = req.user;
//     const { testInstanceId } = req.params;

//     // --- PHASE 1: VALIDATION & PRE-CHECKS ---
//     if (!uid) {
//       return res
//         .status(401)
//         .json({ success: false, error: "User not authenticated" });
//     }
//     if (!testInstanceId) {
//       return res
//         .status(400)
//         .json({ success: false, error: "Test instance ID is required." });
//     }

//     // Fetch progress from Redis
//     const redisKey = `progress:${testInstanceId}`;
//     const savedProgress = await redisClient.hGetAll(redisKey);

//     if (Object.keys(savedProgress).length === 0) {
//       return res.status(400).json({
//         success: false,
//         error: "No progress found in Redis to submit.",
//       });
//     }

//     // Process Redis data into a usable format
//     const totalTimeTakenSec = parseFloat(savedProgress._totalTime || "0");
//     delete savedProgress._totalTime;

//     const answers = Object.entries(savedProgress).map(([questionId, data]) => {
//       const parsedData = JSON.parse(data);
//       return {
//         questionId: Number(questionId),
//         userAnswer: parsedData.answer,
//         timeTaken: Math.round(parsedData.time || 0),
//       };
//     });

//     // Verify the test instance in the database
//     const testInstance = await prisma.userTestInstanceSummary.findUnique({
//       where: { id: testInstanceId, userId: uid },
//       include: {
//         exam: true,
//         // Ensure this is actually a group test
//         GroupTestParticipant: true,
//       },
//     });

//     if (
//       !testInstance ||
//       !testInstance.exam ||
//       !testInstance.GroupTestParticipant
//     ) {
//       return res.status(404).json({
//         success: false,
//         error: "Group test instance not found for this user.",
//       });
//     }
//     if (testInstance.completedAt) {
//       await redisClient.del(redisKey); // Clean up stale Redis data
//       return res.status(409).json({
//         success: false,
//         error: "This test has already been submitted.",
//       });
//     }

//     // --- PHASE 2: DATA FETCHING & PREPARATION ---
//     const questionIds = answers.map((a) => a.questionId);
//     const questions = await prisma.question.findMany({
//       where: { id: { in: questionIds } },
//       include: {
//         subtopic: { include: { topic: true } },
//       },
//     });
//     const questionsMap = new Map(questions.map((q) => [q.id, q]));

//     const subtopicIds = [...new Set(questions.map((q) => q.subtopicId))];
//     const topicIds = [...new Set(questions.map((q) => q.subtopic.topicId))];

//     // Fetch existing performance records to update them
//     const [
//       currentTopicPerfs,
//       currentSubtopicPerfs,
//       currentTopicDifficultyPerfs,
//     ] = await Promise.all([
//       prisma.userTopicPerformance.findMany({
//         where: { userId: uid, topicId: { in: topicIds } },
//       }),
//       prisma.userSubtopicPerformance.findMany({
//         where: { userId: uid, subtopicId: { in: subtopicIds } },
//       }),
//       prisma.userTopicDifficultyPerformance.findMany({
//         where: { userId: uid, topicId: { in: topicIds } },
//       }),
//     ]);

//     const topicPerfMap = new Map(currentTopicPerfs.map((p) => [p.topicId, p]));
//     const subtopicPerfMap = new Map(
//       currentSubtopicPerfs.map((p) => [p.subtopicId, p])
//     );
//     const topicDifficultyPerfMap = new Map(
//       currentTopicDifficultyPerfs.map((p) => [
//         `${p.topicId}-${p.difficultyLevel}`,
//         p,
//       ])
//     );

//     // --- PHASE 3: ANSWER PROCESSING & AGGREGATION ---
//     let totalCorrect = 0;
//     let totalIncorrect = 0;
//     const userTestAnswerPayloads = [];
//     const topicUpdates = new Map();
//     const subtopicUpdates = new Map();
//     const topicDifficultyUpdates = new Map();

//     for (const answer of answers) {
//       const question = questionsMap.get(answer.questionId);
//       if (!question) continue;

//       let isCorrect = false;
//       let status: AnswerStatus = AnswerStatus.Unattempted;
//       const userAnswer = answer.userAnswer?.trim() ?? null;

//       if (userAnswer) {
//         isCorrect =
//           userAnswer.toUpperCase() ===
//           question.correctOption.trim().toUpperCase();
//         status = isCorrect ? AnswerStatus.Correct : AnswerStatus.Incorrect;
//         if (isCorrect) totalCorrect++;
//         else totalIncorrect++;

//         // Aggregate performance updates
//         const { topicId } = question.subtopic;
//         const { subtopicId } = question;
//         const { humanDifficultyLevel, id: qId } = question;
//         const time = answer.timeTaken || 0;

//         const updateAggregator = (
//           map: Map<any, any>,
//           key: any,
//           isCorrect: boolean,
//           time: number
//         ) => {
//           const update = map.get(key) || { attempted: 0, correct: 0, time: 0 };
//           update.attempted++;
//           update.correct += isCorrect ? 1 : 0;
//           update.time += time;
//           map.set(key, update);
//         };

//         updateAggregator(topicUpdates, topicId, isCorrect, time);
//         updateAggregator(subtopicUpdates, subtopicId, isCorrect, time);
//         updateAggregator(
//           topicDifficultyUpdates,
//           `${topicId}-${humanDifficultyLevel}`,
//           isCorrect,
//           time
//         );
//       }

//       userTestAnswerPayloads.push({
//         testInstanceId,
//         questionId: question.id,
//         userId: uid,
//         userAnswer: answer.userAnswer || null,
//         isCorrect,
//         status,
//         timeTakenSec: answer.timeTaken || 0,
//       });
//     }

//     const totalAttempted = totalCorrect + totalIncorrect;
//     const totalUnattempted = testInstance.totalQuestions - totalAttempted;

//     // --- PHASE 4: DATABASE TRANSACTION ---
//     const transactionPromises = [];

//     // Promise 1: Create all UserTestAnswer records
//     if (userTestAnswerPayloads.length > 0) {
//       transactionPromises.push(
//         prisma.userTestAnswer.createMany({ data: userTestAnswerPayloads })
//       );
//     }

//     // Promise 2: Upsert UserTopicPerformance records
//     for (const [topicId, update] of topicUpdates.entries()) {
//       const currentPerf = topicPerfMap.get(topicId);
//       const newTotalAttempted =
//         (currentPerf?.totalAttempted || 0) + update.attempted;
//       const newTotalCorrect = (currentPerf?.totalCorrect || 0) + update.correct;
//       const newTotalTimeTaken =
//         (currentPerf?.totalTimeTakenSec || 0) + update.time;
//       transactionPromises.push(
//         prisma.userTopicPerformance.upsert({
//           where: { userId_topicId: { userId: uid, topicId } },
//           create: {
//             userId: uid,
//             topicId,
//             totalAttempted: update.attempted,
//             totalCorrect: update.correct,
//             totalIncorrect: update.attempted - update.correct,
//             totalTimeTakenSec: update.time,
//             accuracyPercent: (update.correct / update.attempted) * 100,
//             avgTimePerQuestionSec: update.time / update.attempted,
//           },
//           update: {
//             totalAttempted: { increment: update.attempted },
//             totalCorrect: { increment: update.correct },
//             totalIncorrect: { increment: update.attempted - update.correct },
//             totalTimeTakenSec: { increment: update.time },
//             accuracyPercent:
//               newTotalAttempted > 0
//                 ? (newTotalCorrect / newTotalAttempted) * 100
//                 : 0,
//             avgTimePerQuestionSec:
//               newTotalAttempted > 0 ? newTotalTimeTaken / newTotalAttempted : 0,
//           },
//         })
//       );
//     }

//     // Promise 3: Upsert UserSubtopicPerformance records
//     for (const [subtopicId, update] of subtopicUpdates.entries()) {
//       const currentPerf = subtopicPerfMap.get(subtopicId);
//       const newTotalAttempted =
//         (currentPerf?.totalAttempted || 0) + update.attempted;
//       const newTotalCorrect = (currentPerf?.totalCorrect || 0) + update.correct;
//       const newTotalTimeTaken =
//         (currentPerf?.totalTimeTakenSec || 0) + update.time;
//       transactionPromises.push(
//         prisma.userSubtopicPerformance.upsert({
//           where: { userId_subtopicId: { userId: uid, subtopicId } },
//           create: {
//             userId: uid,
//             subtopicId,
//             totalAttempted: update.attempted,
//             totalCorrect: update.correct,
//             totalIncorrect: update.attempted - update.correct,
//             totalTimeTakenSec: update.time,
//             accuracyPercent: (update.correct / update.attempted) * 100,
//             avgTimePerQuestionSec: update.time / update.attempted,
//           },
//           update: {
//             totalAttempted: { increment: update.attempted },
//             totalCorrect: { increment: update.correct },
//             totalIncorrect: { increment: update.attempted - update.correct },
//             totalTimeTakenSec: { increment: update.time },
//             accuracyPercent:
//               newTotalAttempted > 0
//                 ? (newTotalCorrect / newTotalAttempted) * 100
//                 : 0,
//             avgTimePerQuestionSec:
//               newTotalAttempted > 0 ? newTotalTimeTaken / newTotalAttempted : 0,
//           },
//         })
//       );
//     }

//     // Promise 4: Upsert UserTopicDifficultyPerformance records
//     for (const [key, update] of topicDifficultyUpdates.entries()) {
//       const [topicIdStr, difficultyLevel] = key.split("-");
//       const topicId = parseInt(topicIdStr);
//       const currentPerf = topicDifficultyPerfMap.get(key);
//       const newTotalAttempted =
//         (currentPerf?.totalAttempted || 0) + update.attempted;
//       const newTotalCorrect = (currentPerf?.totalCorrect || 0) + update.correct;
//       const newTotalTimeTaken =
//         (currentPerf?.totalTimeTakenSec || 0) + update.time;
//       transactionPromises.push(
//         prisma.userTopicDifficultyPerformance.upsert({
//           where: {
//             userId_topicId_difficultyLevel: {
//               userId: uid,
//               topicId,
//               difficultyLevel: difficultyLevel as DifficultyLevel,
//             },
//           },
//           create: {
//             userId: uid,
//             topicId,
//             difficultyLevel: difficultyLevel as DifficultyLevel,
//             totalAttempted: update.attempted,
//             totalCorrect: update.correct,
//             totalTimeTakenSec: update.time,
//             accuracyPercent: (update.correct / update.attempted) * 100,
//             avgTimePerQuestionSec: update.time / update.attempted,
//           },
//           update: {
//             totalAttempted: { increment: update.attempted },
//             totalCorrect: { increment: update.correct },
//             totalTimeTakenSec: { increment: update.time },
//             accuracyPercent:
//               newTotalAttempted > 0
//                 ? (newTotalCorrect / newTotalAttempted) * 100
//                 : 0,
//             avgTimePerQuestionSec:
//               newTotalAttempted > 0 ? newTotalTimeTaken / newTotalAttempted : 0,
//           },
//         })
//       );
//     }

//     // Promise 5: Update the final test summary
//     const { marksPerCorrect, negativeMarksPerIncorrect } = testInstance.exam;
//     const finalScore =
//       totalCorrect * marksPerCorrect -
//       totalIncorrect * negativeMarksPerIncorrect;

//     transactionPromises.push(
//       prisma.userTestInstanceSummary.update({
//         where: { id: testInstanceId },
//         data: {
//           score: finalScore,
//           numCorrect: totalCorrect,
//           numIncorrect: totalIncorrect,
//           numUnattempted: totalUnattempted,
//           timeTakenSec: Math.round(totalTimeTakenSec),
//           completedAt: new Date(),
//         },
//       })
//     );

//     // Execute the transaction
//     await prisma.$transaction(transactionPromises);

//     // --- PHASE 5: CLEANUP ---
//     await redisClient.del(redisKey);

//     // --- PHASE 6: BACKGROUND AGGREGATE UPDATES (FIRE-AND-FORGET) ---
//     setImmediate(() => {
//       updateGlobalTopicAverages(topicIds).catch(console.error);
//       updateGlobalSubtopicAverages(subtopicIds).catch(console.error);
//       updateUserOverallAverage(uid).catch(console.error);
//     });

//     // --- PHASE 7: RESPOND TO USER ---
//     const accuracyPercent =
//       totalAttempted > 0 ? (totalCorrect / totalAttempted) * 100 : 0;
//     res.status(200).json({
//       success: true,
//       data: {
//         summary: {
//           testInstanceId,
//           score: finalScore,
//           totalMarks: testInstance.totalMarks,
//           accuracyPercentage: Number(accuracyPercent.toFixed(2)),
//           totalCorrect,
//           totalIncorrect,
//           totalUnattempted,
//           timeTakenSec: Math.round(totalTimeTakenSec),
//         },
//       },
//     });
//   } catch (error) {
//     console.error("Error submitting group test:", error);
//     if (error instanceof Prisma.PrismaClientKnownRequestError) {
//       if (error.code === "P2025")
//         return res
//           .status(404)
//           .json({ success: false, error: "Record to update not found." });
//       if (error.code === "P2002")
//         return res.status(409).json({
//           success: false,
//           error: "Duplicate entry. Test may have already been submitted.",
//         });
//     }
//     res.status(500).json({ success: false, error: "Internal server error" });
//   }
// };

// type PerfAccumulator = {
//   attempted: number;
//   correct: number;
//   time: number;
// };

// /**
//  * ROUTE: GET /group-test/:groupTestId/results
//  * Fetches the results and analysis of a group test.
//  */
// export const getGroupTestResults = async (req: Request, res: Response) => {
//   try {
//     const { uid } = req.user;
//     const { groupTestId } = req.params;

//     if (!uid) {
//       return res
//         .status(401)
//         .json({ success: false, error: "User not authenticated" });
//     }

//     if (!groupTestId) {
//       return res
//         .status(400)
//         .json({ success: false, error: "Group test ID is required." });
//     }

//     // --- 1. Fetch Core Group Test Data ---
//     const groupTest = await prisma.groupTest.findUnique({
//       where: { id: groupTestId },
//       include: {
//         participants: {
//           include: {
//             user: { select: { id: true, fullName: true } },
//             userTestInstance: true,
//           },
//         },
//       },
//     });

//     if (!groupTest || groupTest.participants.length === 0) {
//       return res.status(404).json({
//         success: false,
//         error:
//           "Group test results not found or no participants have submitted.",
//       });
//     }

//     const currentUserParticipant = groupTest.participants.find(
//       (p) => p.userId === uid
//     );
//     if (!currentUserParticipant) {
//       return res.status(403).json({
//         success: false,
//         error: "You are not a participant of this group test.",
//       });
//     }

//     // --- 2. Fetch Detailed Performance Data in Batches ---
//     const participantTestInstanceIds = groupTest.participants.map(
//       (p) => p.userTestInstanceId
//     );

//     const allAnswers = await prisma.userTestAnswer.findMany({
//       where: { testInstanceId: { in: participantTestInstanceIds } },
//     });

//     const allQuestionIds = [...new Set(allAnswers.map((a) => a.questionId))];
//     const allQuestions = await prisma.question.findMany({
//       where: { id: { in: allQuestionIds } },
//       include: {
//         subtopic: { include: { topic: { select: { id: true, name: true } } } },
//       },
//     });
//     const questionsMap = new Map(allQuestions.map((q) => [q.id, q]));

//     // --- 3. Process and Aggregate Data for Each User ---
//     const userPerformance = new Map<
//       string,
//       {
//         topicPerf: Map<number, PerfAccumulator>;
//         subtopicPerf: Map<number, PerfAccumulator>;
//         difficultyPerf: Map<string, PerfAccumulator>;
//       }
//     >();

//     const usersMap = new Map(
//       groupTest.participants.map((p) => [p.userId, p.user])
//     );

//     for (const participant of groupTest.participants) {
//       userPerformance.set(participant.userId, {
//         topicPerf: new Map(),
//         subtopicPerf: new Map(),
//         difficultyPerf: new Map(),
//       });
//     }

//     for (const answer of allAnswers) {
//       if (answer.status === "Unattempted") continue;

//       const question = questionsMap.get(answer.questionId);
//       if (!question || !question.subtopic || !question.subtopic.topic) continue;

//       const userPerf = userPerformance.get(answer.userId)!;
//       const { topic, topicId } = question.subtopic;
//       const { id: subtopicId } = question.subtopic;
//       const { humanDifficultyLevel: difficulty } = question;

//       const updateMap = (map: Map<any, PerfAccumulator>, key: any) => {
//         const perf = map.get(key) || { attempted: 0, correct: 0, time: 0 };
//         perf.attempted++;
//         if (answer.isCorrect) perf.correct++;
//         perf.time += answer.timeTakenSec;
//         map.set(key, perf);
//       };

//       updateMap(userPerf.topicPerf, topicId);
//       updateMap(userPerf.subtopicPerf, subtopicId);
//       updateMap(userPerf.difficultyPerf, difficulty);
//     }

//     // --- 4. Calculate Group Averages ---
//     const groupTopicPerf = new Map<number, PerfAccumulator>();
//     const groupSubtopicPerf = new Map<number, PerfAccumulator>();
//     const groupDifficultyPerf = new Map<string, PerfAccumulator>();

//     let groupTotalScore = 0;
//     let groupTotalTime = 0;
//     let groupTotalCorrect = 0;
//     let groupTotalAttempted = 0;

//     for (const participant of groupTest.participants) {
//       const perf = userPerformance.get(participant.userId)!;

//       // Accumulate overall group stats from the test summary
//       groupTotalScore += participant.userTestInstance.score;
//       groupTotalTime += participant.userTestInstance.timeTakenSec;
//       groupTotalCorrect += participant.userTestInstance.numCorrect;
//       groupTotalAttempted +=
//         participant.userTestInstance.numCorrect +
//         participant.userTestInstance.numIncorrect;

//       // --- Aggregate Performance by Topic ---
//       perf.topicPerf.forEach((data, key) => {
//         const groupData = groupTopicPerf.get(key) || {
//           attempted: 0,
//           correct: 0,
//           time: 0,
//         };
//         groupData.attempted += data.attempted;
//         groupData.correct += data.correct;
//         groupData.time += data.time;
//         groupTopicPerf.set(key, groupData);
//       });

//       // --- Aggregate Performance by Subtopic ---
//       perf.subtopicPerf.forEach((data, key) => {
//         const groupData = groupSubtopicPerf.get(key) || {
//           attempted: 0,
//           correct: 0,
//           time: 0,
//         };
//         groupData.attempted += data.attempted;
//         groupData.correct += data.correct;
//         groupData.time += data.time;
//         groupSubtopicPerf.set(key, groupData);
//       });

//       // --- Aggregate Performance by Difficulty ---
//       perf.difficultyPerf.forEach((data, key) => {
//         const groupData = groupDifficultyPerf.get(key) || {
//           attempted: 0,
//           correct: 0,
//           time: 0,
//         };
//         groupData.attempted += data.attempted;
//         groupData.correct += data.correct;
//         groupData.time += data.time;
//         groupDifficultyPerf.set(key, groupData);
//       });
//     }

//     const numParticipants = groupTest.participants.length;

//     // --- 5. Generate Leaderboard and Ranks ---
//     const leaderboard = groupTest.participants
//       .map((p) => ({
//         userId: p.userId,
//         name: p.user.fullName,
//         score: p.userTestInstance.score,
//         timeTakenSec: p.userTestInstance.timeTakenSec,
//       }))
//       .sort((a, b) => b.score - a.score);

//     const currentUserRank = leaderboard.findIndex((p) => p.userId === uid) + 1;

//     const topicRanks = new Map<number, number>();
//     const topicTopPerformers = new Map<
//       number,
//       { userId: string; accuracy: number }
//     >();

//     allQuestions
//       .map((q) => q.subtopic.topic.id)
//       .forEach((topicId: any) => {
//         const topicLeaderboard = groupTest.participants
//           .map((p) => {
//             const perf = userPerformance.get(p.userId)!.topicPerf.get(topicId);
//             const accuracy =
//               perf && perf.attempted > 0
//                 ? (perf.correct / perf.attempted) * 100
//                 : 0;
//             return { userId: p.userId, accuracy };
//           })
//           .sort((a, b) => b.accuracy - a.accuracy);

//         topicRanks.set(
//           topicId,
//           topicLeaderboard.findIndex((p) => p.userId === uid) + 1
//         );
//         topicTopPerformers.set(topicId, topicLeaderboard[0]!);
//       });

//     // --- 6. Generate Peer Comparison Insights ---
//     const peerComparisonInsights = [];
//     const rankPercentileThreshold = numParticipants / 2;

//     const userWeakTopics = [];
//     for (const [topicId, rank] of topicRanks.entries()) {
//       if (rank > rankPercentileThreshold) {
//         const userPerf = userPerformance.get(uid)!.topicPerf.get(topicId);
//         const userAccuracy =
//           userPerf && userPerf.attempted > 0
//             ? (userPerf.correct / userPerf.attempted) * 100
//             : 0;

//         const topPerformer = topicTopPerformers.get(topicId)!;
//         const gap = topPerformer.accuracy - userAccuracy;

//         userWeakTopics.push({ topicId, rank, gap, userAccuracy });
//       }
//     }

//     userWeakTopics.sort((a, b) => b.gap - a.gap);

//     for (const weakTopic of userWeakTopics.slice(0, 10)) {
//       const topic = allQuestions.find(
//         (q) => q.subtopic.topic.id === weakTopic.topicId
//       )?.subtopic.topic;
//       const topPerformerData = topicTopPerformers.get(weakTopic.topicId)!;
//       const topPerformerName = usersMap.get(topPerformerData.userId)?.fullName;
//       const groupPerf = groupTopicPerf.get(weakTopic.topicId)!;
//       const groupAvgAccuracy = (groupPerf.correct / groupPerf.attempted) * 100;

//       const insight = `In '${topic?.name}', you ranked ${
//         weakTopic.rank
//       }/${numParticipants} with ${weakTopic.userAccuracy.toFixed(
//         1
//       )}% accuracy. The top performer, ${topPerformerName}, achieved ${topPerformerData.accuracy.toFixed(
//         1
//       )}%. The group average was ${groupAvgAccuracy.toFixed(1)}%.`;
//       peerComparisonInsights.push(insight);
//     }

//     // --- 7. Assemble Final Response Object ---
//     const currentUserPerf = userPerformance.get(uid)!;

//     const formatPerf = (
//       map: Map<any, PerfAccumulator>,
//       nameMap: Map<number | string, string>
//     ) => {
//       return Object.fromEntries(
//         Array.from(map.entries()).map(([id, perf]) => [
//           nameMap.get(id) || id,
//           {
//             accuracy:
//               perf.attempted > 0
//                 ? parseFloat(((perf.correct / perf.attempted) * 100).toFixed(2))
//                 : 0,
//             avgTimeSec:
//               perf.attempted > 0
//                 ? parseFloat((perf.time / perf.attempted).toFixed(2))
//                 : 0,
//             attempted: perf.attempted,
//             correct: perf.correct,
//           },
//         ])
//       );
//     };

//     // Create the lookup maps for human-readable names
//     const topicNameMap = new Map(
//       allQuestions.map((q) => [q.subtopic.topic.id, q.subtopic.topic.name])
//     );
//     const subtopicNameMap = new Map(
//       allQuestions.map((q) => [q.subtopic.id, q.subtopic.name])
//     );
//     // For difficulty, the key is already the name, so we map it to itself
//     const difficultyNameMap = new Map(
//       Object.values(DifficultyLevel).map((level) => [level, level])
//     );

//     const results = {
//       // --- Individual User's Detailed Results ---
//       individual: {
//         userId: uid,
//         rank: currentUserRank,
//         summary: currentUserParticipant.userTestInstance,
//         topicPerformance: formatPerf(currentUserPerf.topicPerf, topicNameMap),
//         subtopicPerformance: formatPerf(
//           currentUserPerf.subtopicPerf,
//           subtopicNameMap
//         ),
//         difficultyPerformance: formatPerf(
//           currentUserPerf.difficultyPerf,
//           difficultyNameMap
//         ),
//       },
//       // --- Aggregated Group Performance ---
//       group: {
//         participantCount: numParticipants,
//         averageScore: parseFloat(
//           (groupTotalScore / numParticipants).toFixed(2)
//         ),
//         averageTimeSec: parseFloat(
//           (groupTotalTime / numParticipants).toFixed(2)
//         ),
//         overallAccuracy:
//           groupTotalAttempted > 0
//             ? parseFloat(
//                 ((groupTotalCorrect / groupTotalAttempted) * 100).toFixed(2)
//               )
//             : 0,
//         topicPerformance: formatPerf(groupTopicPerf, topicNameMap),
//         subtopicPerformance: formatPerf(groupSubtopicPerf, subtopicNameMap),
//         difficultyPerformance: formatPerf(
//           groupDifficultyPerf,
//           difficultyNameMap
//         ),
//       },
//       // --- Overall and Granular Rankings ---
//       leaderboard: leaderboard.map((p, index) => ({ rank: index + 1, ...p })),
//       topicRanks: Object.fromEntries(topicRanks.entries()),
//       // --- Actionable Insights for Improvement ---
//       peerComparisonInsights,
//     };

//     res.json({ success: true, data: results });
//   } catch (error) {
//     console.error("Error getting group test results:", error);
//     res.status(500).json({ success: false, error: "Internal server error" });
//   }
// };

// /**
//  * ROUTE: DELETE /study-room/:roomId/members/:userId
//  * Removes a member from a study room.
//  */
// export const removeMemberFromStudyRoom = async (
//   req: Request,
//   res: Response
// ) => {
//   try {
//     const { uid } = req.user;
//     const { roomId, userId } = req.params;

//     if (!uid) {
//       return res.status(401).json({ error: "User not authenticated" });
//     }

//     if (!roomId) {
//       return res.status(400).json({ error: "Room ID is required" });
//     }

//     if (!userId) {
//       return res.status(400).json({ error: "User ID is required" });
//     }

//     const room = await prisma.studyRoom.findUnique({
//       where: { id: roomId },
//       include: { admins: true },
//     });

//     if (!room) {
//       return res.status(404).json({ error: "Study room not found" });
//     }

//     if (!room.admins.some((admin) => admin.id === uid)) {
//       return res.status(403).json({ error: "Only admins can remove members" });
//     }

//     await prisma.studyRoomMember.delete({
//       where: {
//         studyRoomId_userId: {
//           studyRoomId: roomId,
//           userId: userId,
//         },
//       },
//     });

//     res.json({ success: true, message: "Member removed successfully" });
//   } catch (error) {
//     console.error("Error removing member from study room:", error);
//     res.status(500).json({ error: "Internal server error" });
//   }
// };
