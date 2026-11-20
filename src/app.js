import cors from "cors";
import express from "express";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import bookingRoutes from "./routes/bookings/routes.js";
import healthRoutes from "./routes/healthRoutes.js";
import serviceRoutes from "./routes/services/routes.js";
import userRoutes from "./routes/users/routes.js";

import technicianRoutes from "./routes/technician/routes.js";
import adminRoutes from "./routes/admin/routes.js";
import customerRoutes from "./routes/customer/routes.js";
import paymentRoutes from "./routes/payments/routes.js";
import { stripeWebhook } from "./config/payments.js";
import { connectDB } from "./config/db.js";

// Vercel loads this module directly instead of running index.js.
if (process.env.VERCEL) {
  await connectDB();
}

const app = express();

app.disable("x-powered-by");
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.post("/api/payments/webhook", express.raw({ type: "application/json", limit: "100kb" }), stripeWebhook);
app.use(express.json({ limit: "100kb" }));

app.get("/", (req, res) => {
  res.status(200).json({ success: true, message: "FixMate API is running" });
});

app.use("/api/health", healthRoutes);
app.use("/api/users", userRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/technician", technicianRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/payments", paymentRoutes);

// Business handlers will be added in later phases with authentication.
app.use(notFound);
app.use(errorHandler);

export default app;
