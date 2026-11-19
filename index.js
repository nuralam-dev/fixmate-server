import "dotenv/config";
import app from "./src/app.js";
import { closeDatabase, connectToDatabase } from "./src/config/db.js";

const PORT = process.env.PORT || 4000;

try {
  await connectToDatabase();
  console.log("MongoDB connection verified.");

  const server = app.listen(PORT, () => {
    console.log(`FixMate API is listening on port ${PORT}.`);
  });

  server.on("error", async () => {
    console.error("HTTP server could not start. Check the configured port.");
    await closeDatabase().catch(() => {});
    process.exitCode = 1;
  });

  const shutdown = () => {
    server.close(async () => {
      try {
        await closeDatabase();
      } catch {
        console.error("Database connection could not close cleanly.");
        process.exitCode = 1;
      }
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  // Do not log the original driver error: it may contain connection details.
  console.error("Startup failed. Check MONGODB_URI and MongoDB network access.");
  await closeDatabase().catch(() => {});
  process.exitCode = 1;
}
