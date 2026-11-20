import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, mock, test } from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import app from "../src/app.js";
import { connectDB, closeDB } from "../src/config/db.js";

let server, authServer, url, bookings, calls, failDB, failAuth, malformedAuth;
const users = {
  a: { id: "a", name: "Customer A", email: "a@example.com", role: "customer" },
  b: { id: "b", name: "Customer B", email: "b@example.com", role: "customer" },
  technician: { id: "t", name: "Technician", email: "t@example.com", role: "technician" },
  admin: { id: "d", name: "Admin", email: "d@example.com", role: "admin" },
};
const projection = { _id: 1, serviceTitle: 1, preferredDate: 1, status: 1, createdAt: 1 };
function matches(record, filter) {
  assert.equal(typeof filter.customerEmail, "string", "Every query must constrain verified customer ownership");
  return Object.entries(filter).every(([key, value]) =>
    value?.$in ? value.$in.includes(record[key]) : record[key] === value);
}
before(async () => {
  authServer = createServer((req, res) => {
    const authUrl = new URL(req.url, "http://localhost");
    assert.equal(authUrl.pathname, "/api/auth/get-session");
    assert.equal(authUrl.searchParams.get("disableCookieCache"), "true");
    assert.equal(authUrl.searchParams.get("disableRefresh"), "true");
    res.setHeader("Content-Type", "application/json");
    if (failAuth) { res.writeHead(500); return res.end("{}"); }
    if (malformedAuth) return res.end("not json");
    const key = req.headers.cookie?.replace("fixture=", "");
    const user = users[key] || (["expired", "mismatch"].includes(key) ? users.a : null);
    res.end(JSON.stringify(user ? {
      user, session: {
        userId: key === "mismatch" ? users.b.id : user.id,
        expiresAt: key === "expired" ? "2000-01-01" : new Date(Date.now() + 60000).toISOString(),
      },
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
        assert.equal(name, "bookings", "Overview must not read other collections");
        calls++;
        if (failDB) throw new Error("private-db-error");
      }
      return {
        countDocuments: async filter => {
          access();
          return bookings.filter(record => matches(record, filter)).length;
        },
        find: (filter, options) => {
          access();
          assert.deepEqual(Object.keys(filter), ["customerEmail"]);
          assert.deepEqual(options, { projection });
          return { sort: sort => {
            assert.deepEqual(sort, { createdAt: -1, _id: -1 });
            return { limit: limit => {
              assert.equal(limit, 5);
              return { toArray: async () => bookings.filter(record => matches(record, filter))
                .sort((a, b) => b.createdAt - a.createdAt || b._id.toString().localeCompare(a._id.toString()))
                .slice(0, limit).map(record => Object.fromEntries(
                  Object.keys(projection).filter(key => key in record).map(key => [key, record[key]]),
                )) };
            } };
          } };
        },
      };
    },
  }));
  await connectDB();
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}/api/customer/overview`;
});
beforeEach(() => { bookings = []; calls = 0; failDB = failAuth = malformedAuth = false; });
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (authServer) await new Promise(resolve => authServer.close(resolve));
  await closeDB();
  mock.restoreAll();
});
function request(who = "a", query = "") {
  return fetch(url + query, { headers: who ? { Cookie: `fixture=${who}` } : {} });
}
function seed() {
  bookings = ["requested", "accepted", "in-progress", "completed", "rejected", "cancelled", "requested", "completed"]
    .map((status, index) => ({
      _id: new ObjectId(), customerEmail: users.a.email, status,
      serviceTitle: `Repair ${index}`, preferredDate: "2026-12-01",
      createdAt: new Date(2026, 10, index + 1), customerPhone: "private-phone", address: "private-address",
      technicianEmail: "private-technician@example.com", paymentStatus: "unpaid",
    }));
  bookings.push({ ...bookings[0], _id: new ObjectId(), customerEmail: users.b.email, createdAt: new Date(2027, 0, 1) });
}
test("customer overview counts all six statuses and returns latest five owned bookings", async () => {
  seed(); bookings.reverse();
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const { data, success, message } = await response.json();
  assert.equal(success, true);
  assert.equal(typeof message, "string");
  const { recentBookings, ...counts } = data;
  assert.deepEqual(counts, { totalBookings: 8, pendingRequests: 2, activeBookings: 2, completedBookings: 2 });
  assert.deepEqual(recentBookings.map(record => record.serviceTitle), ["Repair 7", "Repair 6", "Repair 5", "Repair 4", "Repair 3"]);
  assert.equal(calls, 5);
});
test("A/B isolation ignores frontend supplied identity and role", async () => {
  seed();
  const a = (await (await request("a", "?customerEmail=b@example.com&customerName=Fake&role=admin")).json()).data;
  const b = (await (await request("b", "?email=a@example.com")).json()).data;
  assert.equal(a.totalBookings, 8);
  assert.equal(b.totalBookings, 1);
  assert.equal(b.pendingRequests, 1);
  assert.ok(a.recentBookings.every(record => record._id !== b.recentBookings[0]._id));
});
test("empty customer gets zeros and []", async () => {
  assert.deepEqual((await (await request()).json()).data, {
    totalBookings: 0, pendingRequests: 0, activeBookings: 0, completedBookings: 0, recentBookings: [],
  });
});
test("projection excludes unrelated personal fields and handles missing stored fields", async () => {
  seed(); delete bookings[7].preferredDate;
  const { data } = await (await request()).json();
  assert.equal(data.recentBookings[0].preferredDate, undefined);
  for (const record of data.recentBookings) {
    for (const field of ["customerEmail", "customerPhone", "address", "technicianEmail", "paymentStatus"])
      assert.equal(record[field], undefined);
  }
});
test("guests, invalid/expired/mismatched sessions and other roles denied before DB reads", async () => {
  for (const [who, status] of [[null, 401], ["invalid", 401], ["expired", 401], ["mismatch", 401], ["technician", 403], ["admin", 403]]) {
    assert.equal((await request(who)).status, status);
  }
  assert.equal(calls, 0);
});
test("auth-service failures and malformed auth fail closed", async () => {
  failAuth = true;
  assert.equal((await request()).status, 503);
  failAuth = false; malformedAuth = true;
  assert.equal((await request()).status, 503);
  assert.equal(calls, 0);
});
test("DB failure returns safe error without partial statistics", async () => {
  failDB = true;
  const response = await request();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { success: false, message: "Something went wrong" });
});
test("refresh reflects technician changes and overview never mutates bookings", async () => {
  seed();
  const before = structuredClone(bookings);
  await request();
  assert.deepEqual(structuredClone(bookings), before);
  bookings[0].status = "accepted";
  const { data } = await (await request()).json();
  assert.equal(data.pendingRequests, 1);
  assert.equal(data.activeBookings, 3);
});
