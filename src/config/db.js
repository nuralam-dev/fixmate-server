import { MongoClient } from "mongodb";

const DATABASE_NAME = "fixmateDB";
let client;
let database;

export async function connectToDatabase() {
  if (database) return database;

  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required.");
  }

  client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  try {
    await client.connect();
    const connectedDatabase = client.db(DATABASE_NAME);
    await connectedDatabase.command({ ping: 1 });
    database = connectedDatabase;
    return database;
  } catch {
    await closeDatabase().catch(() => {});
    throw new Error("MongoDB connection failed.");
  }
}

export function getDatabase() {
  if (!database) throw new Error("Database is not connected.");
  return database;
}

export async function closeDatabase() {
  database = undefined;
  if (client) {
    await client.close();
    client = undefined;
  }
}
