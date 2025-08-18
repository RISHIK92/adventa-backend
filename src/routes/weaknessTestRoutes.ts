import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import {
  getAvailableExams,
  getWeakestTopics,
  generateWeaknessTest,
  submitWeaknessTest,
  getWeaknessTestResults,
  getTestDataForTaking,
  getAccuracyComparison,
  getWeaknessTestSummary,
  getWeaknessTestHistory,
} from "../controllers/weaknessTestController.js";

const router = Router();

router.get("/exams", verifyFirebaseToken, getAvailableExams);
router.get("/preview/:examId", verifyFirebaseToken, getWeakestTopics);
router.get(
  "/test-details/:testInstanceId",
  verifyFirebaseToken,
  getTestDataForTaking
);
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
router.get(`/history`, verifyFirebaseToken, getWeaknessTestHistory);

export default router;
