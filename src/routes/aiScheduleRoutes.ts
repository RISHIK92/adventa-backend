import {
  generateWeeklySchedule,
  getMonthlySchedule,
  getScheduleProfile,
  getTopicsForScheduling,
  updateSession,
  upsertScheduleProfile,
} from "../controllers/aiScheduleController.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import { Router } from "express";

const router = Router();

router.get("/topics/:examId", verifyFirebaseToken, getTopicsForScheduling);
router.post("/profile", verifyFirebaseToken, upsertScheduleProfile);
router.post("/generate-week", verifyFirebaseToken, generateWeeklySchedule);
router.get("/month", verifyFirebaseToken, getMonthlySchedule);
router.patch("/session/:sessionId", verifyFirebaseToken, updateSession);
router.get("/profile/:examId", verifyFirebaseToken, getScheduleProfile);

export default router;
