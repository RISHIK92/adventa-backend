import { Router } from "express";
import { generate, VideoStatus } from "../controllers/videoController.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";

const router = Router();

router.post("/generate", verifyFirebaseToken, generate);

router.get("/status/:jobId", verifyFirebaseToken, VideoStatus);

export default router;
