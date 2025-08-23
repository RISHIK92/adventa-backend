import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import {
  getMarkedTestProgress,
  getTestProgress,
  saveMarkedTestProgress,
  saveTestProgress,
} from "../controllers/progressController.js";

const router = Router();

router.post("/progress/:testInstanceId", verifyFirebaseToken, saveTestProgress);
router.get("/progress/:testInstanceId", verifyFirebaseToken, getTestProgress);
router.post(
  "/mark-progress/:testInstanceId",
  verifyFirebaseToken,
  saveMarkedTestProgress
);
router.get(
  "/mark-progress/:testInstanceId",
  verifyFirebaseToken,
  getMarkedTestProgress
);

export default router;
