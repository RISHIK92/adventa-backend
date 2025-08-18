import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import {
  getTestProgress,
  saveTestProgress,
} from "../controllers/progressController.js";

const router = Router();

router.post("/progress/:testInstanceId", verifyFirebaseToken, saveTestProgress);
router.get("/progress/:testInstanceId", verifyFirebaseToken, getTestProgress);

export default router;
