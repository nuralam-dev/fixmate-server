import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, mock, test } from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import app from "../src/app.js";
import { connectDB, closeDB } from "../src/config/db.js";

let server, authServer, baseUrl, records, calls, writes, failDB, failAuth;
const id = new ObjectId();
const identities = {
  admin: { id: "admin", name: "Admin", email: "admin@example.com", role: "admin" },
  tech: { id: "tech", name: "Technician", email: "tech@example.com", role: "technician" },
  other: { id: "other", name: "Other Technician", email: "other@example.com", role: "technician" },
  customer: { id: "customer", name: "Customer", email: "customer@example.com", role: "customer" },
};
const fields = {
  title: "Fixture AC repair", category: "AC", description: "Fixture repair description",
  image: "https://example.com/repair.jpg", basePrice: 50, estimatedDuration: "1 hour",
  serviceMode: "Home Visit", serviceArea: "Dhaka",
};
function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) =>
    key === "_id" ? record._id.equals(value) : record[key] === value);
}

before(async () => {
  authServer = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    assert.equal(url.pathname, "/api/auth/get-session");
    assert.equal(url.searchParams.get("disableCookieCache"), "true");
    assert.equal(url.searchParams.get("disableRefresh"), "true");
    res.setHeader("Content-Type", "application/json");
    if (failAuth) { res.writeHead(500); res.end("{}"); return; }
    const key = req.headers.cookie?.replace("fixture=", "");
    const user = identities[key];
    res.end(JSON.stringify(user ? {
      user, session: { userId: user.id, expiresAt: new Date(Date.now() + 60000).toISOString() },
    } : key === "expired" ? {
      user: identities.admin, session: { userId: "admin", expiresAt: "2000-01-01" },
    } : null));
  });
  authServer.listen(0, "127.0.0.1");
  await once(authServer, "listening");
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${authServer.address().port}`;
  mock.method(MongoClient.prototype, "connect", async () => {});
  mock.method(MongoClient.prototype, "close", async () => {});
  mock.method(MongoClient.prototype, "db", () => ({
    command: async () => ({ ok: 1 }),
    collection: name => {
      function access() {
        assert.equal(name, "services", "Admin review must not read/write other collections");
        calls++;
        if (failDB) throw new Error("private-database-details");
      }
      return {
        find: filter => {
          access();
          return { sort: sort => {
            assert.equal(sort.createdAt, -1);
            return { toArray: async () => records.filter(record => matches(record, filter))
              .sort((a, b) => b.createdAt - a.createdAt || b._id.toString().localeCompare(a._id.toString())) };
          } };
        },
        findOne: async filter => { access(); return records.find(record => matches(record, filter)) || null; },
        findOneAndUpdate: async (filter, update, options) => {
          access();
          assert.deepEqual(Object.keys(filter).sort(), ["_id", "approvalStatus"]);
          assert.equal(filter.approvalStatus, "pending");
          assert.ok(filter._id instanceof ObjectId);
          assert.deepEqual(options, { returnDocument: "after" });
          assert.deepEqual(Object.keys(update), ["$set"]);
          assert.deepEqual(Object.keys(update.$set).sort(), ["approvalStatus", "updatedAt"]);
          assert.ok(update.$set.updatedAt instanceof Date);
          const record = records.find(record => matches(record, filter));
          if (!record) return null;
          Object.assign(record, update.$set);
          writes++;
          return { ...record };
        },
        insertOne: async record => {
          access();
          const insertedId = new ObjectId();
          records.push({ ...record, _id: insertedId });
          return { insertedId };
        },
      };
    },
  }));
  await connectDB();
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  calls = writes = 0;
  failDB = failAuth = false;
  records = [{
    ...fields, _id: id, technicianName: identities.tech.name,
    technicianEmail: identities.tech.email, approvalStatus: "pending",
    isAvailable: true, createdAt: new Date("2026-11-01"),
  }];
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (authServer) await new Promise(resolve => authServer.close(resolve));
  await closeDB();
  mock.restoreAll();
});
function request(method = "GET", who = "admin", body, path) {
  return fetch(`${baseUrl}${path ?? (method === "GET" ? "/api/admin/services" : `/api/admin/services/${id}/approval`)}`, {
    method,
    headers: { ...(who ? { Cookie: `fixture=${who}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("admin GET includes all approval/availability states, all technicians, newest first", async () => {
  records = [];
  for (const approvalStatus of ["pending", "approved", "rejected"]) {
    for (const isAvailable of [true, false]) {
      records.push({
        ...fields, _id: new ObjectId(), approvalStatus, isAvailable,
        technicianEmail: isAvailable ? identities.tech.email : identities.other.email,
        createdAt: new Date(2026, 10, records.length + 1),
      });
    }
  }
  const response = await request("GET", "admin", undefined, "/api/admin/services?approvalStatus=pending&technicianEmail=spoof@example.com&role=technician");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.deepEqual(result.data.map(record => record._id), records.toReversed().map(record => record._id.toString()));
  assert.equal(writes, 0);
});
test("admin GET empty list returns []", async () => {
  records = [];
  assert.deepEqual((await (await request()).json()).data, []);
});
test("GET/PATCH deny guests, invalid and expired sessions, technicians and customers before DB", async () => {
  for (const method of ["GET", "PATCH"]) {
    for (const [who, status] of [[null, 401], ["invalid", 401], ["expired", 401], ["tech", 403], ["customer", 403]]) {
      const response = await request(method, who, method === "PATCH" ? { approvalStatus: "approved", role: "admin" } : undefined);
      assert.equal(response.status, status);
      assert.match(response.headers.get("cache-control"), /private, no-store/);
    }
  }
  assert.equal(calls, 0);
});
test("auth service failure returns safe 503 and never accesses services", async () => {
  failAuth = true;
  for (const method of ["GET", "PATCH"]) {
    assert.equal((await request(method, "admin", method === "PATCH" ? { approvalStatus: "approved" } : undefined)).status, 503);
  }
  assert.equal(calls, 0);
});
for (const approvalStatus of ["approved", "rejected"]) {
  test(`PATCH pending -> ${approvalStatus} changes only approvalStatus/updatedAt`, async () => {
    const original = { ...records[0] };
    const response = await request("PATCH", "admin", { approvalStatus });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.approvalStatus, approvalStatus);
    assert.equal(records[0].approvalStatus, approvalStatus);
    const { updatedAt, ...remaining } = records[0];
    assert.ok(updatedAt instanceof Date);
    assert.deepEqual(remaining, { ...original, approvalStatus });
    assert.equal(writes, 1);
  });
}
test("PATCH invalid IDs and unsupported/protected payloads return 400 without DB reads", async () => {
  for (const invalid of ["bad", "123", "g".repeat(24)]) {
    assert.equal((await request("PATCH", "admin", { approvalStatus: "approved" }, `/api/admin/services/${invalid}/approval`)).status, 400);
  }
  for (const body of [null, [], {}, { approvalStatus: "pending" }, { approvalStatus: "Approved" },
    { approvalStatus: true }, { approvalStatus: "approved", role: "admin" },
    { approvalStatus: "approved", isAvailable: true }, { approvalStatus: "rejected", technicianEmail: "spoof@example.com" }]) {
    assert.equal((await request("PATCH", "admin", body)).status, 400);
  }
  assert.equal(calls, 0);
});
test("PATCH absent service returns 404", async () => {
  assert.equal((await request("PATCH", "admin", { approvalStatus: "approved" }, `/api/admin/services/${new ObjectId()}/approval`)).status, 404);
  assert.equal(writes, 0);
});
test("PATCH reviewed services return 409 for both decisions and preserve updatedAt", async () => {
  for (const current of ["approved", "rejected"]) {
    records[0].approvalStatus = current;
    records[0].updatedAt = new Date("2026-11-01");
    for (const approvalStatus of ["approved", "rejected"]) {
      assert.equal((await request("PATCH", "admin", { approvalStatus })).status, 409);
      assert.equal(records[0].approvalStatus, current);
      assert.equal(records[0].updatedAt.toISOString(), "2026-11-01T00:00:00.000Z");
    }
  }
  assert.equal(writes, 0);
});
test("concurrent approve/reject and repeated decisions produce exactly one write", async () => {
  const responses = await Promise.all([
    request("PATCH", "admin", { approvalStatus: "approved" }),
    request("PATCH", "admin", { approvalStatus: "rejected" }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(writes, 1);
  assert.equal((await request("PATCH", "admin", { approvalStatus: "approved" })).status, 409);
  assert.equal(writes, 1);
});
test("POST pending -> admin approval -> public list/detail and owner My Services", async () => {
  records = [];
  const created = await request("POST", "tech", fields, "/api/services");
  assert.equal(created.status, 201);
  const service = (await created.json()).data;
  assert.equal(service.approvalStatus, "pending");
  assert.deepEqual((await (await request("GET", null, undefined, "/api/services")).json()).data, []);
  assert.equal((await request("GET", null, undefined, `/api/services/${service._id}`)).status, 404);
  const approved = await request("PATCH", "admin", { approvalStatus: "approved" }, `/api/admin/services/${service._id}/approval`);
  assert.equal(approved.status, 200);
  assert.equal((await (await request("GET", null, undefined, "/api/services")).json()).data[0]._id, service._id);
  assert.equal((await request("GET", null, undefined, `/api/services/${service._id}`)).status, 200);
  const mine = await request("GET", "tech", undefined, "/api/services/my");
  assert.equal((await mine.json()).data[0].approvalStatus, "approved");
  assert.deepEqual((await (await request("GET", "other", undefined, "/api/services/my")).json()).data, []);
});
test("approved unavailable stays hidden; rejected stays hidden and owner sees rejection", async () => {
  records[0].isAvailable = false;
  assert.equal((await request("PATCH", "admin", { approvalStatus: "approved" })).status, 200);
  assert.equal(records[0].isAvailable, false);
  assert.deepEqual((await (await request("GET", null, undefined, "/api/services")).json()).data, []);
  assert.equal((await request("GET", null, undefined, `/api/services/${id}`)).status, 404);
  records[0].approvalStatus = "pending";
  records[0].isAvailable = true;
  assert.equal((await request("PATCH", "admin", { approvalStatus: "rejected" })).status, 200);
  assert.deepEqual((await (await request("GET", null, undefined, "/api/services")).json()).data, []);
  assert.equal((await request("GET", null, undefined, `/api/services/${id}`)).status, 404);
  assert.equal((await (await request("GET", "tech", undefined, "/api/services/my")).json()).data[0].approvalStatus, "rejected");
});
test("GET/PATCH DB failures return safe 500 and never write", async () => {
  failDB = true;
  for (const method of ["GET", "PATCH"]) {
    const response = await request(method, "admin", method === "PATCH" ? { approvalStatus: "approved" } : undefined);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private-database-details/);
  }
  assert.equal(writes, 0);
});
