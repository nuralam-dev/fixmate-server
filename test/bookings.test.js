import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, mock, test } from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import app from "../src/app.js";
import { connectDB, closeDB } from "../src/config/db.js";

let server, authServer, baseUrl;
let records, calls, writes, failDB, failAuth;
const identities = {
  a: { id: "a", name: "Tech A", email: "a@example.com", role: "technician" },
  b: { id: "b", name: "Tech B", email: "b@example.com", role: "technician" },
  customer: { id: "c", name: "Customer", email: "c@example.com", role: "customer" },
  admin: { id: "d", name: "Admin", email: "d@example.com", role: "admin" },
};
const id = new ObjectId();
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
      user: identities.a, session: { userId: "a", expiresAt: "2000-01-01" },
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
      assert.equal(name === "bookings" || ["user", "services", "payments"].includes(name), true);
      function access() {
        assert.equal(name, "bookings", "Do not access unrelated collections");
        calls++;
        if (failDB) throw new Error("private-database-details");
      }
      return {
        find: filter => {
          access();
          assert.deepEqual(Object.keys(filter), ["technicianEmail"]);
          return { sort: sort => {
            assert.deepEqual(sort, { createdAt: -1, _id: -1 });
            return { toArray: async () => records.filter(record => matches(record, filter))
              .sort((a, b) => b.createdAt - a.createdAt) };
          } };
        },
        findOne: async filter => { access(); return records.find(record => matches(record, filter)) || null; },
        findOneAndUpdate: async (filter, update, options) => {
          access();
          assert.deepEqual(Object.keys(filter).sort(), ["_id", "status", "technicianEmail"]);
          assert.equal(filter.status, { accepted: "requested", rejected: "requested", "in-progress": "accepted", completed: "in-progress" }[update.$set.status]);
          assert.ok(filter._id instanceof ObjectId);
          assert.deepEqual(options, { returnDocument: "after" });
          assert.deepEqual(Object.keys(update), ["$set"]);
          assert.deepEqual(Object.keys(update.$set).sort(), update.$set.status === "completed" ? ["finalAmount", "status", "updatedAt"] : ["status", "updatedAt"]);
          assert.ok(update.$set.updatedAt instanceof Date);
          const record = records.find(record => matches(record, filter));
          if (!record) return null;
          Object.assign(record, update.$set);
          writes++;
          return { ...record };
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
    _id: id, technicianEmail: identities.a.email, status: "requested",
    serviceTitle: "AC repair", customerName: "Fixture Customer", customerPhone: "000",
    address: "Fixture address", preferredDate: new Date("2026-12-01"),
    problemDescription: "Fixture problem", basePrice: 50, finalAmount: 50,
    paymentStatus: "unpaid", createdAt: new Date("2026-11-01"),
  }];
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (authServer) await new Promise(resolve => authServer.close(resolve));
  await closeDB();
  mock.restoreAll();
});
function request(method = "GET", who = "a", body, path) {
  return fetch(`${baseUrl}/api/bookings${path ?? (method === "GET" ? "/technician" : `/${id}/status`)}`, {
    method,
    headers: { ...(who ? { Cookie: `fixture=${who}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("GET isolates technicians, includes all states, sorts newest, ignores spoofed email", async () => {
  const statuses = ["accepted", "rejected", "cancelled", "in-progress", "completed"];
  records.push(...statuses.map((status, index) => ({
    ...records[0], _id: new ObjectId(), status, createdAt: new Date(2026, 10, index + 2),
  })));
  records.push({ ...records[0], _id: new ObjectId(), technicianEmail: identities.b.email });
  const response = await request("GET", "a", undefined, "/technician?technicianEmail=b@example.com&role=admin");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  const { data } = await response.json();
  assert.equal(data.length, 6);
  assert.ok(data.every(record => record.technicianEmail === identities.a.email));
  assert.deepEqual(data.map(record => record.status), ["completed", "in-progress", "cancelled", "rejected", "accepted", "requested"]);
  assert.equal((await (await request("GET", "b")).json()).data.length, 1);
});
test("GET empty owner returns empty array", async () => {
  assert.deepEqual((await (await request("GET", "b")).json()).data, []);
});
test("GET/PATCH reject guests, invalid/expired sessions and non-technician roles before DB access", async () => {
  for (const method of ["GET", "PATCH"]) {
    for (const [who, status] of [[null, 401], ["invalid", 401], ["expired", 401], ["customer", 403], ["admin", 403]]) {
      assert.equal((await request(method, who, method === "PATCH" ? { status: "accepted" } : undefined)).status, status);
    }
  }
  assert.equal(calls, 0);
});
test("GET/PATCH auth-service failure returns safe 503 without database access", async () => {
  failAuth = true;
  for (const method of ["GET", "PATCH"]) {
    assert.equal((await request(method, "a", method === "PATCH" ? { status: "accepted" } : undefined)).status, 503);
  }
  assert.equal(calls, 0);
});
for (const status of ["accepted", "rejected"]) {
  test(`PATCH requested -> ${status} persists only status and updatedAt`, async () => {
    const original = { ...records[0] };
    const response = await request("PATCH", "a", { status });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.data.status, status);
    assert.equal(records[0].status, status);
    assert.ok(records[0].updatedAt instanceof Date);
    const { updatedAt, ...unchanged } = records[0];
    assert.ok(updatedAt);
    assert.deepEqual(unchanged, { ...original, status });
    assert.equal(writes, 1);
    assert.equal((await (await request()).json()).data[0].status, status);
  });
}
test("PATCH rejects invalid IDs and payloads before DB access", async () => {
  for (const invalid of ["bad", "123", "g".repeat(24)]) {
    assert.equal((await request("PATCH", "a", { status: "accepted" }, `/${invalid}/status`)).status, 400);
  }
  for (const body of [null, [], {}, { status: "requested" }, { status: "completed" },
    { status: ["accepted"] }, { status: "cancelled" }, { status: "Accepted" }, { status: 1 }, { status: "accepted", technicianEmail: identities.b.email },
    { status: "accepted", role: "technician" }, { status: "rejected", customerName: "changed" }]) {
    assert.equal((await request("PATCH", "a", body)).status, 400);
  }
  assert.equal(calls, 0);
});
test("PATCH wrong owner and missing record give same 404 with no writes", async () => {
  assert.equal((await request("PATCH", "b", { status: "accepted" })).status, 404);
  assert.equal((await request("PATCH", "a", { status: "accepted" }, `/${new ObjectId()}/status`)).status, 404);
  assert.equal(writes, 0);
  assert.equal(records[0].status, "requested");
});
test("PATCH denies every transition from a processed state with 409", async () => {
  for (const current of ["accepted", "rejected", "cancelled", "completed", "in-progress"]) {
    records[0].status = current;
    for (const status of ["accepted", "rejected"]) {
      assert.equal((await request("PATCH", "a", { status })).status, 409);
      assert.equal(records[0].status, current);
    }
  }
  assert.equal(writes, 0);
});
test("concurrent accept/reject and repeated requests produce exactly one write", async () => {
  const responses = await Promise.all([
    request("PATCH", "a", { status: "accepted" }),
    request("PATCH", "a", { status: "rejected" }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(writes, 1);
  assert.equal((await request("PATCH", "a", { status: "accepted" })).status, 409);
  assert.equal(writes, 1);
});
test("GET/PATCH database failures use safe existing error handler", async () => {
  failDB = true;
  for (const method of ["GET", "PATCH"]) {
    const response = await request(method, "a", method === "PATCH" ? { status: "accepted" } : undefined);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private-database-details/);
  }
  assert.equal(writes, 0);
});


test("assigned technician completes the full pipeline and persists a positive final amount", async () => {
  records[0].finalAmount = null;
  for (const status of ["accepted", "in-progress", "completed"]) {
    const response = await request("PATCH", "a", status === "completed" ? { status, finalAmount: 12.5 } : { status });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.data.status, status);
    assert.equal(records[0].finalAmount, status === "completed" ? 12.5 : null);
    assert.equal(records[0].paymentStatus, "unpaid");
  }
  assert.equal(writes, 3);
  assert.equal((await (await request()).json()).data[0].finalAmount, 12.5);
});
test("completion rejects missing, nonnumeric, nonpositive and protected amounts without writes", async () => {
  records[0].status = "in-progress";
  for (const finalAmount of [undefined, null, "12.50", 0, -1, true, {}, []]) {
    assert.equal((await request("PATCH", "a", { status: "completed", finalAmount })).status, 400);
  }
  for (const body of [{ status: "completed", finalAmount: 10, paymentStatus: "paid" },
    { status: "accepted", finalAmount: 10 }, { status: "in-progress", finalAmount: 10 }]) {
    assert.equal((await request("PATCH", "a", body)).status, 400);
  }
  assert.equal(writes, 0);
});
test("start/completion enforce ownership, roles, exact previous state and reject repeats", async () => {
  for (const [status, previous] of [["in-progress", "accepted"], ["completed", "in-progress"]]) {
    const body = status === "completed" ? { status, finalAmount: 12.5 } : { status };
    records[0].status = previous;
    assert.equal((await request("PATCH", "b", body)).status, 404);
    assert.equal((await request("PATCH", "customer", body)).status, 403);
    assert.equal((await request("PATCH", "admin", body)).status, 403);
    assert.equal((await request("PATCH", null, body)).status, 401);
    for (const current of ["requested", "accepted", "in-progress", "completed", "rejected", "cancelled"].filter(value => value !== previous)) {
      records[0].status = current;
      assert.equal((await request("PATCH", "a", body)).status, 409);
    }
    records[0].status = previous;
    const responses = await Promise.all([request("PATCH", "a", body), request("PATCH", "a", body)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    assert.equal((await request("PATCH", "a", body)).status, 409);
  }
  assert.equal(writes, 2);
});
