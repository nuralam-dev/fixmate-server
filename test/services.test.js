import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, mock, test } from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import app from "../src/app.js";
import { closeDB, connectDB } from "../src/config/db.js";

let server;
let baseUrl;
let savedService;
let insertCalls = 0;
let failInsert = false;
let failRead = false;
let readCalls = 0;

const publicOlder = {
  _id: new ObjectId(), title: "Older public service", approvalStatus: "approved",
  isAvailable: true, createdAt: new Date("2026-01-01"),
};
const publicNewer = {
  _id: new ObjectId(), title: "Newer public service", approvalStatus: "approved",
  isAvailable: true, createdAt: new Date("2026-02-01"),
};
const pendingService = {
  _id: new ObjectId(), approvalStatus: "pending", isAvailable: true,
};
const unavailableService = {
  _id: new ObjectId(), approvalStatus: "approved", isAvailable: false,
};
const rejectedService = {
  _id: new ObjectId(), approvalStatus: "rejected", isAvailable: true,
};
let records = [publicOlder, pendingService, publicNewer, unavailableService, rejectedService];

function findMatchingServices(filter) {
  readCalls++;
  if (failRead) throw new Error("private database connection details");
  return records.filter(record => Object.entries(filter).every(([key, value]) =>
    key === "_id" ? record._id.equals(value) : record[key] === value));
}

const validService = {
  title: " AC repair ",
  category: "AC",
  description: "Diagnose and repair an air conditioner",
  image: "https://example.com/service.jpg",
  basePrice: 50,
  estimatedDuration: "1–2 hours",
  serviceMode: "Home Visit",
  serviceArea: "Dhaka",
  technicianName: "Example Technician",
  technicianEmail: "technician@example.com",
};

before(async () => {
  // Exercise the actual router with an in-memory driver stub; no database writes.
  mock.method(MongoClient.prototype, "connect", async () => {});
  mock.method(MongoClient.prototype, "close", async () => {});
  mock.method(MongoClient.prototype, "db", () => ({
    command: async () => ({ ok: 1 }),
    collection: (name) => ({
      find: (filter) => ({
        sort: (sort) => ({
          toArray: async () => {
            assert.equal(name, "services");
            assert.deepEqual(sort, { createdAt: -1 });
            return findMatchingServices(filter).sort((a, b) => b.createdAt - a.createdAt);
          },
        }),
      }),
      findOne: async (filter) => {
        assert.equal(name, "services");
        assert.ok(filter._id instanceof ObjectId);
        return findMatchingServices(filter)[0] || null;
      },
      insertOne: async (document) => {
        assert.equal(name, "services");
        insertCalls++;
        if (failInsert) throw new Error("private database connection details");
        savedService = document;
        return { insertedId: "test-service-id" };
      },
    }),
  }));
  await connectDB();
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await closeDB();
  mock.restoreAll();
});

function postService(data) {
  return fetch(`${baseUrl}/api/services`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

test("service creation inserts whitelisted fields and server defaults", async () => {
  const startedAt = Date.now();
  const response = await postService({
    ...validService, approvalStatus: "approved", isAvailable: false,
    createdAt: "2000-01-01", extraField: "discard this",
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data._id, "test-service-id");
  assert.equal(savedService.title, "AC repair");
  assert.equal(savedService.basePrice, 50);
  assert.equal(savedService.approvalStatus, "pending");
  assert.equal(savedService.isAvailable, true);
  assert.ok(savedService.createdAt instanceof Date);
  assert.ok(savedService.createdAt.getTime() >= startedAt);
  assert.ok(savedService.createdAt.getTime() <= Date.now());
  assert.equal(savedService.extraField, undefined);
});

test("POST accepts assignment modes and normalizes unambiguous legacy modes", async () => {
  for (const [input, expected] of [
    ["Home Visit", "Home Visit"], ["Shop Drop-off", "Shop Drop-off"],
    ["At home", "Home Visit"], ["Workshop", "Shop Drop-off"],
  ]) {
    const response = await postService({ ...validService, serviceMode: input });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).data.serviceMode, expected);
    assert.equal(savedService.serviceMode, expected);
  }
});

test("invalid service fields never reach insertOne", async () => {
  const beforeCalls = insertCalls;
  for (const invalidFields of [
    { title: " " }, { description: 10 }, { image: "not-a-url" },
    { basePrice: 0 }, { basePrice: -5 }, { basePrice: "50" },
    { basePrice: null }, { category: "Plumbing" }, { serviceMode: "invalid" },
    { serviceMode: "Both" },
    { estimatedDuration: "" }, { serviceArea: "" },
    { technicianName: "" }, { technicianEmail: "invalid-email" },
  ]) {
    const response = await postService({ ...validService, ...invalidFields });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
  }
  const response = await fetch(`${baseUrl}/api/services`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validService).replace('"basePrice":50', '"basePrice":1e400'),
  });
  assert.equal(response.status, 400);
  assert.equal(insertCalls, beforeCalls);
});

test("GET list only returns approved available services, newest first", async () => {
  const response = await fetch(`${baseUrl}/api/services`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.data.map(service => service._id), [
    publicNewer._id.toHexString(), publicOlder._id.toHexString(),
  ]);
});

test("GET list returns an empty array when no public services exist", async () => {
  const originalRecords = records;
  records = [pendingService, unavailableService, rejectedService];
  try {
    const response = await fetch(`${baseUrl}/api/services`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, []);
  } finally {
    records = originalRecords;
  }
});

test("GET details returns an approved available service", async () => {
  const response = await fetch(`${baseUrl}/api/services/${publicOlder._id}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.data, JSON.parse(JSON.stringify(publicOlder)));
});

test("GET details rejects invalid ObjectIds before querying MongoDB", async () => {
  const beforeCalls = readCalls;
  for (const id of ["invalid", "123", "z".repeat(24), "a".repeat(23)]) {
    const response = await fetch(`${baseUrl}/api/services/${id}`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { success: false, message: "Invalid service ID" });
  }
  assert.equal(readCalls, beforeCalls);
});

test("GET details hides missing, pending, rejected and unavailable services with 404", async () => {
  for (const id of [new ObjectId(), pendingService._id, rejectedService._id, unavailableService._id]) {
    const response = await fetch(`${baseUrl}/api/services/${id}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { success: false, message: "Service not found" });
  }
});

test("GET database failures use the existing safe JSON error handler", async () => {
  failRead = true;
  try {
    for (const path of ["/api/services", `/api/services/${publicOlder._id}`]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { success: false, message: "Something went wrong" });
    }
  } finally {
    failRead = false;
  }
});

test("insertion failures return the existing safe JSON 500 response", async () => {
  failInsert = true;
  try {
    const response = await postService(validService);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { success: false, message: "Something went wrong" });
  } finally {
    failInsert = false;
  }
});
