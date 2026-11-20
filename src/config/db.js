
import "dotenv/config";
import { MongoClient } from "mongodb";

const DB_NAME = "fixmateDB";

const client = new MongoClient(process.env.MONGODB_URI);

let db = null;

// Connect MongoDB
export async function connectDB() {
  await client.connect();

  db = client.db(DB_NAME);

  // Check database connection
  await db.command({ ping: 1 });

  console.log("MongoDB connected successfully!");

  return db;
}

// Get collections
export function getCollections() {
  if (!db) {
    throw new Error("Database is not connected");
  }

  return {
    usersCollection: db.collection("user"),
    servicesCollection: db.collection("services"),
    bookingsCollection: db.collection("bookings"),
    paymentsCollection: db.collection("payments"),
  };
}

// Close database connection
export async function closeDB() {
  await client.close();
  db = null;
}

// Keep the shutdown name used by index.js available.
export { closeDB as closeDatabase };

// Share one session across service and booking writes; retries are handled by MongoDB.
export async function withDatabaseTransaction(work) {
  return client.withSession(session => session.withTransaction(() => work(session)));
}
