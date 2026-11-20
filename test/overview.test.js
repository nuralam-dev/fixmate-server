import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, mock, test } from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import app from "../src/app.js";
import { connectDB, closeDB } from "../src/config/db.js";

let server, authServer, url, services, bookings, calls, failDB, failAuth;
const users = {
  a: { id: "a", name: "Tech A", email: "a@example.com", role: "technician" },
  b: { id: "b", name: "Tech B", email: "b@example.com", role: "technician" },
  customer: { id: "c", name: "Customer", email: "c@example.com", role: "customer" },
  admin: { id: "d", name: "Admin", email: "d@example.com", role: "admin" },
};
function matches(record, filter) {
  assert.equal(typeof filter.technicianEmail, "string", "Every query must filter ownership");
  return Object.entries(filter).every(([key, value]) => value?.$in ? value.$in.includes(record[key]) : record[key] === value);
}
before(async () => {
  authServer = createServer((req, res) => {
    const authUrl = new URL(req.url, "http://localhost");
    assert.equal(authUrl.pathname, "/api/auth/get-session");
    assert.equal(authUrl.searchParams.get("disableCookieCache"), "true");
    assert.equal(authUrl.searchParams.get("disableRefresh"), "true");
    res.setHeader("Content-Type", "application/json");
    if (failAuth) { res.writeHead(500); return res.end("{}"); }
    const key = req.headers.cookie?.replace("fixture=", "");
    const user = users[key] || (key === "expired" ? users.a : null);
    res.end(JSON.stringify(user ? { user, session: { userId: user.id, expiresAt: key === "expired" ? "2000-01-01" : new Date(Date.now() + 60000).toISOString() } } : null));
  });
  authServer.listen(0, "127.0.0.1");
  await once(authServer, "listening");
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${authServer.address().port}`;
  mock.method(MongoClient.prototype, "connect", async () => {});
  mock.method(MongoClient.prototype, "close", async () => {});
  mock.method(MongoClient.prototype, "db", () => ({
    command: async () => ({ ok: 1 }),
    collection: name => ({
      countDocuments: async filter => {
        calls++;
        if (failDB) throw new Error("private-db-error");
        assert.ok(["services", "bookings"].includes(name));
        return (name === "services" ? services : bookings).filter(record => matches(record, filter)).length;
      },
      find: (filter, { projection }) => {
        calls++;
        if (failDB) throw new Error("private-db-error");
        assert.equal(name, "bookings");
        assert.deepEqual(Object.keys(filter), ["technicianEmail"]);
        assert.deepEqual(projection, { _id: 1, serviceTitle: 1, customerName: 1, preferredDate: 1, status: 1, basePrice: 1, createdAt: 1 });
        return { sort: sort => {
          assert.deepEqual(sort, { createdAt: -1, _id: -1 });
          return { limit: limit => {
            assert.equal(limit, 5);
            return { toArray: async () => bookings.filter(record => matches(record, filter))
              .sort((a, b) => b.createdAt - a.createdAt || b._id.toString().localeCompare(a._id.toString()))
              .slice(0, limit).map(record => Object.fromEntries(Object.keys(projection).filter(key => key in record).map(key => [key, record[key]]))) };
          } };
        } };
      },
    }),
  }));
  await connectDB();
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}/api/technician/overview`;
});
beforeEach(() => { services = []; bookings = []; calls = 0; failDB = failAuth = false; });
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (authServer) await new Promise(resolve => authServer.close(resolve));
  await closeDB();
  mock.restoreAll();
});
function request(who = "a", query = "") { return fetch(url + query, { headers: who ? { Cookie: `fixture=${who}` } : {} }); }
function seed() {
  services = ["pending", "approved", "rejected"].map(approvalStatus => ({ technicianEmail: users.a.email, approvalStatus, isAvailable: false }));
  services.push({ technicianEmail: users.b.email, approvalStatus: "approved" });
  bookings = ["requested", "accepted", "in-progress", "completed", "rejected", "cancelled", "requested", "completed"].map((status, index) => ({
    _id: new ObjectId(), technicianEmail: users.a.email, status,
    serviceTitle: `Repair ${index}`, customerName: `Customer ${index}`, preferredDate: "2026-12-01", basePrice: index + 10,
    createdAt: new Date(2026, 10, index + 1), customerEmail: "private@example.com", address: "private address",
  }));
  bookings.push({ ...bookings[0], _id: new ObjectId(), technicianEmail: users.b.email, createdAt: new Date(2027, 0, 1) });
}
test("counts all own services and correct booking status groups; latest five by createdAt", async () => {
  seed(); bookings.reverse();
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(typeof result.message, "string");
  const { recentRequests, ...counts } = result.data;
  assert.deepEqual(counts, { totalServices: 3, pendingRequests: 2, activeJobs: 2, completedJobs: 2 });
  assert.deepEqual(recentRequests.map(record => record.serviceTitle), ["Repair 7", "Repair 6", "Repair 5", "Repair 4", "Repair 3"]);
  assert.equal(recentRequests[0].basePrice, 17);
  assert.equal(recentRequests[0].customerName, "Customer 7");
  assert.equal(recentRequests[0].preferredDate, "2026-12-01");
  assert.equal(calls, 5);
});
test("A/B isolation and spoofed identity is ignored", async () => {
  seed();
  const a = (await (await request("a", "?technicianEmail=b@example.com&role=admin")).json()).data;
  const b = (await (await request("b", "?email=a@example.com")).json()).data;
  assert.equal(a.totalServices, 3); assert.equal(b.totalServices, 1);
  assert.equal(b.pendingRequests, 1); assert.equal(b.activeJobs, 0); assert.equal(b.completedJobs, 0);
  assert.equal(b.recentRequests.length, 1);
  assert.ok(a.recentRequests.every(record => record._id !== b.recentRequests[0]._id));
});
test("empty database returns zero counts and no requests", async () => {
  assert.deepEqual((await (await request()).json()).data, { totalServices: 0, pendingRequests: 0, activeJobs: 0, completedJobs: 0, recentRequests: [] });
});
test("recent projection excludes unrelated personal fields and does not invent missing fields", async () => {
  seed(); delete bookings[7].basePrice; delete bookings[7].preferredDate;
  const { data } = await (await request()).json();
  assert.equal(data.recentRequests[0].basePrice, undefined);
  assert.equal(data.recentRequests[0].preferredDate, undefined);
  for (const record of data.recentRequests) for (const field of ["technicianEmail", "customerEmail", "address"]) assert.equal(record[field], undefined);
});
test("guests, invalid/expired credentials, customers and admins denied before database access", async () => {
  for (const [who, status] of [[null, 401], ["invalid", 401], ["expired", 401], ["customer", 403], ["admin", 403]]) {
    assert.equal((await request(who)).status, status);
  }
  assert.equal(calls, 0);
});
test("auth service failure is safe and fail closed", async () => {
  failAuth = true;
  assert.equal((await request()).status, 503);
  assert.equal(calls, 0);
});
test("database failure returns safe error without partial statistics", async () => {
  failDB = true;
  const response = await request();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { success: false, message: "Something went wrong" });
});
test("fresh requests reflect changed stored counts without writes by overview", async () => {
  seed();
  const before = structuredClone({ services, bookings });
  await request();
  assert.deepEqual(structuredClone({ services, bookings }), before);
  bookings[0].status = "accepted";
  services.pop();
  const { data } = await (await request()).json();
  assert.equal(data.pendingRequests, 1); assert.equal(data.activeJobs, 3);
});
