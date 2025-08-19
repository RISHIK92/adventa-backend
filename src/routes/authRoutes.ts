import { Router } from "express";
import { Signin, Signup } from "../controllers/authController.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";

const router = Router();

router.use("/signup", verifyFirebaseToken, Signup);
router.use("/signin", verifyFirebaseToken, Signin);

export default router;

