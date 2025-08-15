import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import { saveTestProgress } from "../controllers/progressController.js";

const router = Router();

router.post("/progress/:testInstanceId", verifyFirebaseToken, saveTestProgress);

export default router;
