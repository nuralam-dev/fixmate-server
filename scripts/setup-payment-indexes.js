import { connectDB, closeDB } from "../src/config/db.js";
try {
  const db = await connectDB();
  for (const field of ["bookingId", "stripeSessionId", "transactionId"]) {
    await db.collection("payments").createIndex({ [field]: 1 }, {
      name: `unique_verified_${field}`, unique: true, partialFilterExpression: { verified: true },
    });
  }
  console.log("Verified payment indexes are ready. Existing records were preserved.");
} catch {
  console.error("Payment index setup failed; check existing data and database access.");
  process.exitCode = 1;
} finally { await closeDB(); }
