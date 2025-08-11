import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import {
  getWeakestTopics,
  generateWeaknessTest,
  submitWeaknessTest,
  getWeaknessTestResults,
} from "../controllers/weaknessTestController.js";

const router = Router();

router.get("/preview", verifyFirebaseToken, getWeakestTopics);
router.post("/generate", verifyFirebaseToken, generateWeaknessTest);
router.post("/submit/:testInstanceId", verifyFirebaseToken, submitWeaknessTest);
router.get(
  "/results/:testInstanceId",
  verifyFirebaseToken,
  getWeaknessTestResults
);

module.exports = router;
