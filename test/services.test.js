import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, mock, test } from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import app from "../src/app.js";
import { closeDB, connectDB } from "../src/config/db.js";

let server;
let authServer;
let authUnavailable = false;
let malformedAuth = false;
const identities = {
  a: { id: "tech-a", name: "Verified Technician", email: "a@example.com", role: "technician" },
  b: { id: "tech-b", name: "Other Technician", email: "b@example.com", role: "technician" },
  customer: { id: "customer", name: "Customer", email: "customer@example.com", role: "customer" },
  admin: { id: "admin", name: "Admin", email: "admin@example.com", role: "admin" },
};
let baseUrl;
let savedService;
let insertCalls = 0;
let failInsert = false;
let failRead = false;
let readCalls = 0;
let updateCalls = 0;
let updateWrites = 0;
let lastUpdate;
let failUpdate = false;
let bookingRecords = [];
let paymentRecords = [];
let relationReads = 0;
let deleteCalls = 0;
let lastDelete;
let failDelete = false;
let failRelations = false;
let disappearBeforeDelete = false;

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

function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some(condition => matches(record, condition));
    if (key === "_id") return record._id.equals(value);
    if (value && typeof value === "object" && Object.hasOwn(value, "$in")) {
      return value.$in.some(candidate => {
        const actual = record[key];
        if (actual instanceof ObjectId || candidate instanceof ObjectId) {
          return actual instanceof ObjectId && candidate instanceof ObjectId && actual.equals(candidate);
        }
        return actual === candidate;
      });
    }
    if (value && typeof value === "object" && Object.hasOwn(value, "$ne")) return record[key] !== value.$ne;
    return record[key] === value;
  });
}

function findMatchingServices(filter) {
  readCalls++;
  if (failRead) throw new Error("private database connection details");
  return records.filter(record => matches(record, filter));
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
  // Auth service fixture; production middleware makes a real HTTP session check.
  authServer = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    assert.equal(url.pathname, "/api/auth/get-session");
    assert.equal(url.searchParams.get("disableCookieCache"), "true");
    assert.equal(url.searchParams.get("disableRefresh"), "true");
    assert.equal(req.headers.authorization, undefined);
    res.setHeader("Content-Type", "application/json");
    if (authUnavailable) { res.writeHead(500); res.end("{}"); return; }
    if (malformedAuth) { res.end("not json"); return; }
    const key = req.headers.cookie?.replace("fixture=", "");
    const user = identities[key];
    res.end(JSON.stringify(user ? {
      user, session: { userId: user.id, expiresAt: new Date(Date.now() + 60000).toISOString(), token: "must-not-leak" },
    } : key === "expired" ? {
      user: identities.a, session: { userId: identities.a.id, expiresAt: "2000-01-01" },
    } : key === "mismatch" ? {
      user: identities.a, session: { userId: identities.b.id, expiresAt: new Date(Date.now() + 60000).toISOString() },
    } : null));
  });
  authServer.listen(0, "127.0.0.1");
  await once(authServer, "listening");
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${authServer.address().port}`;

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
      findOne: async (filter, options) => {
        if (name === "bookings" || name === "payments") {
          relationReads++;
          if (failRelations) throw new Error("private relation database details");
          assert.deepEqual(options, { projection: { _id: 1 } });
          assert.ok(filter.serviceId.$in.some(id => id instanceof ObjectId));
          assert.ok(filter.serviceId.$in.some(id => typeof id === "string"));
          const source = name === "bookings" ? bookingRecords : paymentRecords;
          return source.find(record => matches(record, filter)) || null;
        }
        assert.equal(name, "services");
        assert.ok(filter._id instanceof ObjectId);
        return findMatchingServices(filter)[0] || null;
      },
      findOneAndUpdate: async (filter, update, options) => {
        assert.equal(name, "services");
        assert.ok(filter._id instanceof ObjectId);
        assert.ok(filter.technicianEmail, "Every update must constrain the verified owner");
        assert.deepEqual(options, { returnDocument: "after" });
        assert.deepEqual(Object.keys(update), ["$set"]);
        updateCalls++;
        lastUpdate = { filter, update };
        if (failUpdate) throw new Error("private database connection details");
        const record = findMatchingServices(filter)[0];
        if (!record) return null;
        Object.assign(record, update.$set);
        updateWrites++;
        return { ...record };
      },
      deleteOne: async (filter) => {
        assert.equal(name, "services", "Booking/payment deletes must never occur");
        assert.ok(filter._id instanceof ObjectId);
        assert.ok(filter.technicianEmail);
        assert.deepEqual(Object.keys(filter).sort(), ["_id", "technicianEmail"]);
        lastDelete = filter;
        deleteCalls++;
        if (failDelete) throw new Error("private deletion database details");
        const index = records.findIndex(record => matches(record, filter));
        if (index < 0) return { deletedCount: 0 };
        records.splice(index, 1);
        return { deletedCount: disappearBeforeDelete ? 0 : 1 };
      },
      insertOne: async (document) => {
        assert.equal(name, "services");
        insertCalls++;
        if (failInsert) throw new Error("private database connection details");
        savedService = document;
        const insertedId = new ObjectId();
        records.push({ ...document, _id: insertedId });
        return { insertedId };
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
  if (authServer) await new Promise(resolve => authServer.close(resolve));
  mock.restoreAll();
});

function postService(data) {
  return fetch(`${baseUrl}/api/services`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "fixture=a" },
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
  assert.ok(ObjectId.isValid(body.data._id));
  assert.equal(savedService.title, "AC repair");
  assert.equal(savedService.basePrice, 50);
  assert.equal(savedService.approvalStatus, "pending");
  assert.equal(savedService.isAvailable, true);
  assert.ok(savedService.createdAt instanceof Date);
  assert.ok(savedService.createdAt.getTime() >= startedAt);
  assert.ok(savedService.createdAt.getTime() <= Date.now());
  assert.equal(savedService.extraField, undefined);
  assert.equal(savedService.technicianEmail, identities.a.email);
  assert.equal(savedService.technicianName, identities.a.name);
  assert.equal(body.data.token, undefined);
  assert.equal(body.data.session, undefined);
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
  ]) {
    const response = await postService({ ...validService, ...invalidFields });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
  }
  const response = await fetch(`${baseUrl}/api/services`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: "fixture=a" },
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


test("missing, invalid, expired and mismatched credentials return 401 without service reads or writes", async () => {
  const beforeReads = readCalls;
  const beforeInserts = insertCalls;
  for (const headers of [{}, { Authorization: "Bearer unverified-token" }, { Cookie: "fixture=invalid" }, { Cookie: "fixture=expired" }, { Cookie: "fixture=mismatch" }]) {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${baseUrl}/api/services${method === "GET" ? "/my?email=a@example.com&role=technician" : ""}`, {
        method, headers: { ...headers, "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(validService) : undefined,
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).data, undefined);
    }
  }
  assert.equal(readCalls, beforeReads);
  assert.equal(insertCalls, beforeInserts);
});

test("customer and admin are denied both technician endpoints with 403", async () => {
  const beforeReads = readCalls;
  const beforeInserts = insertCalls;
  for (const identity of ["customer", "admin"]) {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${baseUrl}/api/services${method === "GET" ? "/my?role=technician" : ""}`, {
        method, headers: { Cookie: `fixture=${identity}`, "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify({ ...validService, role: "technician" }) : undefined,
      });
      assert.equal(response.status, 403);
    }
  }
  assert.equal(readCalls, beforeReads);
  assert.equal(insertCalls, beforeInserts);
});

test("My Services includes every own approval/availability state, excludes other owners, and ignores query spoofing", async () => {
  const original = records;
  const own = [
    { ...pendingService, technicianEmail: identities.a.email, createdAt: new Date("2026-01-01") },
    { ...unavailableService, technicianEmail: identities.a.email, createdAt: new Date("2026-02-01") },
    { ...rejectedService, technicianEmail: identities.a.email, createdAt: new Date("2026-03-01") },
  ];
  const other = { ...publicNewer, technicianEmail: identities.b.email };
  records = [...own, other];
  try {
    const response = await fetch(`${baseUrl}/api/services/my?email=b@example.com&technicianEmail=b@example.com`, { headers: { Cookie: "fixture=a" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    assert.deepEqual(body.data.map(s => s._id), own.toReversed().map(s => String(s._id)));
    assert.ok(body.data.every(s => s.technicianEmail === identities.a.email));
    const responseB = await fetch(`${baseUrl}/api/services/my`, { headers: { Cookie: "fixture=b" } });
    assert.deepEqual((await responseB.json()).data.map(s => s._id), [String(other._id)]);
    records = [other];
    const empty = await fetch(`${baseUrl}/api/services/my`, { headers: { Cookie: "fixture=a" } });
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).data, []);
  } finally { records = original; }
});

test("auth outages and malformed responses fail closed without leaking details", async () => {
  const beforeReads = readCalls;
  for (const failure of ["unavailable", "malformed"]) {
    authUnavailable = failure === "unavailable";
    malformedAuth = failure === "malformed";
    try {
      const response = await fetch(`${baseUrl}/api/services/my`, { headers: { Cookie: "fixture=a" } });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { success: false, message: "Authentication verification is temporarily unavailable" });
    } finally { authUnavailable = false; malformedAuth = false; }
  }
  assert.equal(readCalls, beforeReads);
});

test("newly created pending service appears only for its verified owner", async () => {
  const response = await postService({ ...validService, technicianEmail: "b@example.com", technicianName: "Forged name" });
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.equal(data.technicianEmail, identities.a.email);
  assert.equal(data.technicianName, identities.a.name);
  const mine = await fetch(`${baseUrl}/api/services/my`, { headers: { Cookie: "fixture=a" } });
  assert.ok((await mine.json()).data.some(s => s._id === data._id && s.approvalStatus === "pending"));
  const other = await fetch(`${baseUrl}/api/services/my`, { headers: { Cookie: "fixture=b" } });
  assert.ok(!(await other.json()).data.some(s => s._id === data._id));
});

test("POST-to-public-display flow keeps pending hidden and exposes only approved available records", async () => {
  const created = await postService({ ...validService, title: "Integrated service flow" });
  assert.equal(created.status, 201);
  const { data } = await created.json();
  const stored = records.find(record => record._id.toString() === data._id);
  assert.equal(stored.title, "Integrated service flow");
  assert.equal(stored.approvalStatus, "pending");
  assert.equal(stored.isAvailable, true);
  assert.ok(stored.createdAt instanceof Date);
  assert.ok(!(await (await fetch(`${baseUrl}/api/services`)).json()).data.some(service => service._id === data._id));
  assert.equal((await fetch(`${baseUrl}/api/services/${data._id}`)).status, 404);

  // Simulate a later admin approval in the driver fixture, never the live database.
  stored.approvalStatus = "approved";
  try {
    const listing = await (await fetch(`${baseUrl}/api/services`)).json();
    assert.equal(listing.data[0]._id, data._id);
    const details = await fetch(`${baseUrl}/api/services/${data._id}`);
    assert.equal(details.status, 200);
    assert.equal((await details.json()).data.title, stored.title);
    stored.isAvailable = false;
    assert.ok(!(await (await fetch(`${baseUrl}/api/services`)).json()).data.some(service => service._id === data._id));
    assert.equal((await fetch(`${baseUrl}/api/services/${data._id}`)).status, 404);
  } finally {
    stored.approvalStatus = "pending";
  }
});


function patchService(id, data, identity = "a", action = "") {
  return fetch(`${baseUrl}/api/services/${id}${action}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(identity ? { Cookie: `fixture=${identity}` } : {}) },
    body: JSON.stringify(data),
  });
}

async function ownedFixture(approvalStatus = "approved") {
  const response = await postService(validService);
  assert.equal(response.status, 201);
  const { data } = await response.json();
  const stored = records.find(record => record._id.toString() === data._id);
  stored.approvalStatus = approvalStatus; // Isolated driver fixture only.
  return stored;
}

test("owner can edit all supported fields; changes become pending without changing identity, creation or availability", async () => {
  const stored = await ownedFixture();
  const originalCreatedAt = stored.createdAt;
  stored.isAvailable = false;
  const startedAt = Date.now();
  const edits = { title: " Updated service ", category: "Laptop & PC", description: "Updated description", image: "https://example.com/new.jpg", basePrice: 75.25, estimatedDuration: "3 hours", serviceMode: "Shop Drop-off", serviceArea: "Uttara" };
  const response = await patchService(stored._id, edits);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  for (const [field, value] of Object.entries(edits)) assert.equal(stored[field], typeof value === "string" ? value.trim() : value);
  assert.equal(body.data.approvalStatus, "pending");
  assert.equal(stored.technicianEmail, identities.a.email);
  assert.equal(stored.technicianName, identities.a.name);
  assert.equal(stored.createdAt, originalCreatedAt);
  assert.equal(stored.isAvailable, false);
  assert.ok(stored.updatedAt instanceof Date);
  assert.ok(stored.updatedAt.getTime() >= startedAt);
  assert.equal(lastUpdate.filter.technicianEmail, identities.a.email);
  assert.ok(lastUpdate.filter.$or.length === 8);
  const mine = await fetch(`${baseUrl}/api/services/my`, { headers: { Cookie: "fixture=a" } });
  assert.equal((await mine.json()).data.find(service => service._id === String(stored._id)).title, "Updated service");
});

test("no-change normalized edit preserves all approval states and updatedAt", async () => {
  for (const status of ["approved", "rejected", "pending"]) {
    const stored = await ownedFixture(status);
    const beforeWrites = updateWrites;
    const response = await patchService(stored._id, { title: `  ${stored.title}  `, basePrice: stored.basePrice, serviceMode: "At home" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.message, /No service changes/);
    assert.equal(body.data.approvalStatus, status);
    assert.equal(stored.approvalStatus, status);
    assert.equal(stored.updatedAt, undefined);
    assert.equal(updateWrites, beforeWrites);
  }
});

test("edit rejects invalid data, empty patches and all non-editable fields before writes", async () => {
  const stored = await ownedFixture();
  const beforeCalls = updateCalls;
  for (const patch of [
    {}, [], { title: " " }, { title: 5 }, { basePrice: 0 }, { basePrice: -2 }, { basePrice: "50" },
    { basePrice: null }, { category: "Plumbing" }, { image: "file:///secret" }, { image: "javascript:alert(1)" },
    { serviceMode: "Both" }, { serviceMode: 5 }, { serviceArea: "" }, { estimatedDuration: null }, { description: "" },
    ...["_id", "technicianEmail", "technicianName", "createdAt", "approvalStatus", "updatedAt", "isAvailable", "role", "$set", "extra"].map(field => ({ title: "Try to modify", [field]: "forged" })),
  ]) {
    const response = await patchService(stored._id, patch);
    assert.equal(response.status, 400, JSON.stringify(patch));
    assert.equal((await response.json()).success, false);
  }
  assert.equal(updateCalls, beforeCalls);
  assert.equal(stored.approvalStatus, "approved");
});

test("availability accepts explicit true/false, preserves each approval status and edits only availability/date", async () => {
  for (const status of ["approved", "pending", "rejected"]) {
    const stored = await ownedFixture(status);
    const original = { ...stored };
    for (const isAvailable of [false, true, true]) {
      const response = await patchService(stored._id, { isAvailable }, "a", "/availability");
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.isAvailable, isAvailable);
      assert.equal(body.data.approvalStatus, status);
      assert.deepEqual(Object.keys(lastUpdate.update.$set).sort(), ["isAvailable", "updatedAt"]);
      assert.equal(lastUpdate.filter.technicianEmail, identities.a.email);
      assert.ok(stored.updatedAt instanceof Date);
      for (const field of Object.keys(original).filter(key => key !== "isAvailable")) assert.deepEqual(stored[field], original[field]);
    }
  }
});

test("availability rejects missing, non-Boolean and extra fields before writes", async () => {
  const stored = await ownedFixture();
  const beforeCalls = updateCalls;
  for (const patch of [{}, [], { isAvailable: "false" }, { isAvailable: 0 }, { isAvailable: null }, { isAvailable: true, approvalStatus: "approved" }, { isAvailable: false, technicianEmail: identities.a.email }, { isAvailable: true, title: "Changed" }]) {
    const response = await patchService(stored._id, patch, "a", "/availability");
    assert.equal(response.status, 400);
  }
  assert.equal(updateCalls, beforeCalls);
});

test("both PATCH APIs reject missing/invalid sessions and customer/admin roles before database writes", async () => {
  const stored = await ownedFixture();
  const beforeReads = readCalls;
  const beforeCalls = updateCalls;
  for (const action of ["", "/availability"]) {
    for (const [identity, expected] of [[null, 401], ["invalid", 401], ["expired", 401], ["customer", 403], ["admin", 403]]) {
      const response = await patchService(stored._id, action ? { isAvailable: false } : { title: "Forbidden" }, identity, action);
      assert.equal(response.status, expected);
    }
  }
  assert.equal(readCalls, beforeReads);
  assert.equal(updateCalls, beforeCalls);
});

test("both PATCH APIs return 404 for other owners and absent IDs, with ownership in update query", async () => {
  const stored = await ownedFixture();
  const original = { ...stored };
  const beforeWrites = updateWrites;
  for (const action of ["", "/availability"]) {
    for (const id of [stored._id, new ObjectId()]) {
      const response = await patchService(id, action ? { isAvailable: false } : { title: "Stolen" }, "b", action);
      assert.equal(response.status, 404);
      assert.equal(lastUpdate.filter.technicianEmail, identities.b.email);
    }
  }
  assert.equal(updateWrites, beforeWrites);
  assert.deepEqual(stored, original);
});

test("both PATCH APIs validate ObjectIds before database access", async () => {
  const beforeCalls = updateCalls;
  const beforeReads = readCalls;
  for (const action of ["", "/availability"]) for (const id of ["invalid", "my", "a".repeat(23), "z".repeat(24)]) {
    const response = await patchService(id, action ? { isAvailable: false } : { title: "Invalid ID" }, "a", action);
    assert.equal(response.status, 400);
  }
  assert.equal(updateCalls, beforeCalls);
  assert.equal(readCalls, beforeReads);
});

test("edit and availability preserve the public list/details approval and availability gates", async () => {
  const stored = await ownedFixture();
  async function expectVisibility(visible) {
    const list = await fetch(`${baseUrl}/api/services`);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data.some(s => s._id === String(stored._id)), visible);
    assert.equal((await fetch(`${baseUrl}/api/services/${stored._id}`)).status, visible ? 200 : 404);
  }
  await expectVisibility(true);
  await patchService(stored._id, { isAvailable: false }, "a", "/availability");
  await expectVisibility(false);
  await patchService(stored._id, { isAvailable: true }, "a", "/availability");
  await expectVisibility(true);
  await patchService(stored._id, { title: "Edited public service" });
  await expectVisibility(false);
  await patchService(stored._id, { isAvailable: true }, "a", "/availability");
  assert.equal(stored.approvalStatus, "pending");
  await expectVisibility(false);
  stored.approvalStatus = "rejected"; // Driver fixture only, no admin API.
  await patchService(stored._id, { isAvailable: true }, "a", "/availability");
  await expectVisibility(false);
});

test("concurrent identical edits only modify once and preserve latest availability", async () => {
  const stored = await ownedFixture();
  stored.isAvailable = false;
  const beforeWrites = updateWrites;
  const responses = await Promise.all([
    patchService(stored._id, { title: "Concurrent edit" }),
    patchService(stored._id, { title: "Concurrent edit" }),
  ]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(updateWrites, beforeWrites + 1);
  assert.equal(stored.approvalStatus, "pending");
  assert.equal(stored.isAvailable, false);
});

test("PATCH database failures return safe existing 500 responses", async () => {
  const stored = await ownedFixture();
  failUpdate = true;
  try {
    for (const action of ["", "/availability"]) {
      const response = await patchService(stored._id, action ? { isAvailable: false } : { title: "Database failure" }, "a", action);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { success: false, message: "Something went wrong" });
    }
  } finally { failUpdate = false; }
});


function deleteService(id, identity = "a", extra = "") {
  return fetch(`${baseUrl}/api/services/${id}${extra}`, {
    method: "DELETE",
    headers: { ...(identity ? { Cookie: `fixture=${identity}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify({ technicianEmail: identities.b.email, role: "admin" }),
  });
}

test("DELETE removes only an eligible owned service and ignores submitted ownership", async () => {
  const stored = await ownedFixture();
  const survivor = await ownedFixture();
  const response = await deleteService(stored._id, "a", "?technicianEmail=b@example.com&role=admin");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, message: "Service deleted successfully" });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(records.some(record => record._id.equals(stored._id)), false);
  assert.equal(records.some(record => record._id.equals(survivor._id)), true);
  assert.equal(lastDelete.technicianEmail, identities.a.email);
  const mine = await fetch(`${baseUrl}/api/services/my`, { headers: { Cookie: "fixture=a" } });
  assert.ok(!(await mine.json()).data.some(service => service._id === String(stored._id)));
  const publicList = await fetch(`${baseUrl}/api/services`);
  assert.ok(!(await publicList.json()).data.some(service => service._id === String(stored._id)));
  assert.equal((await fetch(`${baseUrl}/api/services/${stored._id}`)).status, 404);
});

test("DELETE denies missing/invalid sessions and customer/admin roles without database work", async () => {
  const stored = await ownedFixture();
  const beforeReads = readCalls;
  const beforeRelations = relationReads;
  const beforeDeletes = deleteCalls;
  for (const [identity, expected] of [[null, 401], ["invalid", 401], ["expired", 401], ["mismatch", 401], ["customer", 403], ["admin", 403]]) {
    const response = await deleteService(stored._id, identity);
    assert.equal(response.status, expected);
    assert.equal((await response.json()).success, false);
  }
  assert.equal(readCalls, beforeReads);
  assert.equal(relationReads, beforeRelations);
  assert.equal(deleteCalls, beforeDeletes);
});

test("DELETE returns 404 for another owner's service and unknown ID without revealing bookings", async () => {
  const stored = await ownedFixture();
  const beforeRelations = relationReads;
  const beforeDeletes = deleteCalls;
  for (const id of [stored._id, new ObjectId()]) {
    const response = await deleteService(id, "b", "?technicianEmail=a@example.com");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { success: false, message: "Service not found" });
  }
  assert.equal(relationReads, beforeRelations);
  assert.equal(deleteCalls, beforeDeletes);
  assert.ok(records.includes(stored));
});

test("DELETE invalid IDs return 400 before service or relation reads", async () => {
  const beforeReads = readCalls;
  const beforeRelations = relationReads;
  for (const id of ["invalid", "my", "a".repeat(23), "z".repeat(24)]) {
    assert.equal((await deleteService(id)).status, 400);
  }
  assert.equal(readCalls, beforeReads);
  assert.equal(relationReads, beforeRelations);
});

test("DELETE blocks each active booking status with exact 409 message for String and ObjectId references", async () => {
  const stored = await ownedFixture();
  const beforeDeletes = deleteCalls;
  try {
    for (const serviceId of [String(stored._id), stored._id]) {
      for (const status of ["requested", "accepted", "in-progress"]) {
        bookingRecords = [{ _id: new ObjectId(), serviceId, status, problemDescription: "Keep unchanged" }];
        const original = structuredClone(bookingRecords.map(record => ({ ...record, _id: String(record._id), serviceId: String(record.serviceId) })));
        const response = await deleteService(stored._id);
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { success: false, message: "Cannot delete this service because it has active bookings." });
        assert.deepEqual(bookingRecords.map(record => ({ ...record, _id: String(record._id), serviceId: String(record.serviceId) })), original);
        assert.ok(records.includes(stored));
      }
    }
  } finally { bookingRecords = []; }
  assert.equal(deleteCalls, beforeDeletes);
});

test("DELETE preserves historical bookings and linked payments instead of deleting referenced services", async () => {
  const stored = await ownedFixture();
  const beforeDeletes = deleteCalls;
  try {
    for (const serviceId of [String(stored._id), stored._id]) {
      for (const status of ["completed", "rejected", "cancelled", "unknown"]) {
        bookingRecords = [{ _id: new ObjectId(), serviceId, status }];
        paymentRecords = [{ _id: new ObjectId(), bookingId: bookingRecords[0]._id, paymentStatus: "paid", amount: 50 }];
        const originalBookings = JSON.stringify(bookingRecords);
        const originalPayments = JSON.stringify(paymentRecords);
        const response = await deleteService(stored._id);
        assert.equal(response.status, 409);
        assert.match((await response.json()).message, /booking or payment history/);
        assert.equal(JSON.stringify(bookingRecords), originalBookings);
        assert.equal(JSON.stringify(paymentRecords), originalPayments);
        assert.ok(records.includes(stored));
      }
    }
  } finally { bookingRecords = []; paymentRecords = []; }
  assert.equal(deleteCalls, beforeDeletes);
});

test("DELETE protects direct service-linked payment history for both reference types", async () => {
  const stored = await ownedFixture();
  const beforeDeletes = deleteCalls;
  try {
    for (const serviceId of [String(stored._id), stored._id]) {
      paymentRecords = [{ _id: new ObjectId(), serviceId, paymentStatus: "paid" }];
      const original = JSON.stringify(paymentRecords);
      const response = await deleteService(stored._id);
      assert.equal(response.status, 409);
      assert.match((await response.json()).message, /payment history/);
      assert.equal(JSON.stringify(paymentRecords), original);
    }
  } finally { paymentRecords = []; }
  assert.equal(deleteCalls, beforeDeletes);
});

test("DELETE does not block unrelated bookings/payments or mutate their data", async () => {
  const stored = await ownedFixture();
  bookingRecords = [{ _id: new ObjectId(), serviceId: new ObjectId(), status: "requested" }];
  paymentRecords = [{ _id: new ObjectId(), serviceId: String(new ObjectId()), paymentStatus: "paid" }];
  const originalBookings = JSON.stringify(bookingRecords);
  const originalPayments = JSON.stringify(paymentRecords);
  try {
    assert.equal((await deleteService(stored._id)).status, 200);
    assert.equal(JSON.stringify(bookingRecords), originalBookings);
    assert.equal(JSON.stringify(paymentRecords), originalPayments);
  } finally { bookingRecords = []; paymentRecords = []; }
});

test("DELETE respects deletedCount and repeated requests cannot delete twice", async () => {
  const stored = await ownedFixture();
  assert.equal((await deleteService(stored._id)).status, 200);
  const beforeDeletes = deleteCalls;
  assert.equal((await deleteService(stored._id)).status, 404);
  assert.equal(deleteCalls, beforeDeletes);
  const other = await ownedFixture();
  disappearBeforeDelete = true;
  try { assert.equal((await deleteService(other._id)).status, 404); }
  finally { disappearBeforeDelete = false; }
});

test("DELETE database/relation errors fail closed with safe JSON and no booking/payment mutations", async () => {
  const stored = await ownedFixture();
  for (const failure of ["read", "relations", "delete"]) {
    failRead = failure === "read";
    failRelations = failure === "relations";
    failDelete = failure === "delete";
    try {
      const response = await deleteService(stored._id);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { success: false, message: "Something went wrong" });
      assert.ok(records.includes(stored));
    } finally { failRead = false; failRelations = false; failDelete = false; }
  }
});
