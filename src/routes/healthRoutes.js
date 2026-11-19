import { Router } from "express";

const router = Router();

// HTTP liveness only. Startup verifies MongoDB, but this route does not ping it.
router.get("/", (req, res) => {
  res.status(200).json({ success: true, message: "FixMate API is running" });
});

export default router;
