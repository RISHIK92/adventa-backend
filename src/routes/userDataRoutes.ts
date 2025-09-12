import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import { getAnalyticsData } from "../controllers/userDataController.js";

const router = Router();

router.get("/analytics", verifyFirebaseToken, getAnalyticsData);

export default router;
