import { Router } from "express";
import {
  generateQuiz,
  getDrillDashboard,
  getDrillOptions,
  generateDrill,
  getDrillDataForTaking,
  submitDrill,
  getDrillResults,
} from "../controllers/drillController.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";

const router = Router();

// AI-powered quiz generation
router.post("/quiz/generate", verifyFirebaseToken, generateQuiz);

// Drill dashboard (list of completed drills)
router.get("/dashboard/:examId", verifyFirebaseToken, getDrillDashboard);

// Drill options (subjects and topics for modal)
router.get("/options/:examId", verifyFirebaseToken, getDrillOptions);

// Generate a new drill
router.post("/drill/generate", verifyFirebaseToken, generateDrill);

// Get drill data for taking the test
router.get("/test/:testInstanceId", verifyFirebaseToken, getDrillDataForTaking);

// Submit a drill
router.post("/submit/:testInstanceId", verifyFirebaseToken, submitDrill);

// Get detailed results of a completed drill
router.get("/results/:testInstanceId", verifyFirebaseToken, getDrillResults);

export default router;
