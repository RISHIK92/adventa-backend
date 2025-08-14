import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import {
  getAvailableExams,
  getWeakestTopics,
  generateWeaknessTest,
  submitWeaknessTest,
  getWeaknessTestResults,
  getAccuracyComparison,
  getWeaknessTestSummary,
} from "../controllers/weaknessTestController.js";
import { defineDmmfProperty } from "@prisma/client/runtime/library";

const router = Router();

router.get("/exams", verifyFirebaseToken, getAvailableExams);
router.get("/preview/:examId", verifyFirebaseToken, getWeakestTopics);
router.post("/generate", verifyFirebaseToken, generateWeaknessTest);
router.post("/submit/:testInstanceId", verifyFirebaseToken, submitWeaknessTest);
router.get(
  "/results/:testInstanceId",
  verifyFirebaseToken,
  getWeaknessTestResults
);
router.get(
  "/accuracy-comparison/:testInstanceId",
  verifyFirebaseToken,
  getAccuracyComparison
);
router.get(
  `/results/:testInstanceId/summary`,
  verifyFirebaseToken,
  getWeaknessTestSummary
);

export default router;
