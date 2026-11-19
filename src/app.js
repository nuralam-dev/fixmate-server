import cors from "cors";
import express from "express";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import healthRoutes from "./routes/healthRoutes.js";

const app = express();

app.disable("x-powered-by");
app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true,
}));
app.use(express.json({ limit: "100kb" }));

app.get("/", (req, res) => {
  res.status(200).json({ success: true, message: "FixMate API is running" });
});

app.use("/api/health", healthRoutes);

// Business routes will be added in later phases with authentication.
app.use(notFound);
app.use(errorHandler);

export default app;
