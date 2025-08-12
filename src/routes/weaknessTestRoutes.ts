import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import {
  getAvailableExams,
  getWeakestTopics,
  generateWeaknessTest,
  submitWeaknessTest,
  getWeaknessTestResults,
} from "../controllers/weaknessTestController.js";

const router = Router();

router.get("/exams", verifyFirebaseToken, getAvailableExams);
router.get("/preview", verifyFirebaseToken, getWeakestTopics);
router.post("/generate", verifyFirebaseToken, generateWeaknessTest);
router.post("/submit/:testInstanceId", verifyFirebaseToken, submitWeaknessTest);
router.get(
  "/results/:testInstanceId",
  verifyFirebaseToken,
  getWeaknessTestResults
);

module.exports = router;
