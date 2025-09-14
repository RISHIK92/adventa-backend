import {
  generateWeeklySchedule,
  getMonthlySchedule,
  updateSession,
  upsertScheduleProfile,
} from "../controllers/aiScheduleController.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import { Router } from "express";

const router = Router();

router.post("/profile", verifyFirebaseToken, upsertScheduleProfile);
router.post("/generate-week", verifyFirebaseToken, generateWeeklySchedule);
router.get("/month", verifyFirebaseToken, getMonthlySchedule);
router.patch("/session/:sessionId", verifyFirebaseToken, updateSession);

export default router;
