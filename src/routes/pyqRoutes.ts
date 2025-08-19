import { Router } from "express";
const router = Router();
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import {
  generatePyqTest,
  getAvailablePyqs,
  getLatestPyqResultId,
  getPyqBestScore,
  getPyqDataForTaking,
  getPyqTestResults,
  getPyqPercentile,
  submitPyqTest,
} from "../controllers/pyqController.js";

// Get available exam years for a specific exam
router.get("/available/:examId", verifyFirebaseToken, getAvailablePyqs);

router.get(
  "/latest-result/:examSessionId",
  verifyFirebaseToken,
  getLatestPyqResultId
);

// Generate PYQ test
router.post("/generate", verifyFirebaseToken, generatePyqTest);

router.get("/test/:testInstanceId", verifyFirebaseToken, getPyqDataForTaking);

// Get PYQ test details
router.post("/submit/:testId", verifyFirebaseToken, submitPyqTest);

router.get(
  "/percentile/:testInstanceId",
  verifyFirebaseToken,
  getPyqPercentile
);

router.get("/best-score/:examSessionId", verifyFirebaseToken, getPyqBestScore);

router.get("/results/:testInstanceId", verifyFirebaseToken, getPyqTestResults);

export default router;
