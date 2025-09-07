import { getDailyPlan } from "../controllers/aiPipelineController.js";
import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";

const router = Router();

router.get("/daily-plan/:examId", verifyFirebaseToken, getDailyPlan);

export default router;
