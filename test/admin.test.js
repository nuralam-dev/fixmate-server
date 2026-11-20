import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, mock, test } from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import app from "../src/app.js";
import { connectDB, closeDB, getCollections } from "../src/config/db.js";

const adminId = new ObjectId(),
  customerId = new ObjectId(),
  techId = new ObjectId();
const identities = {
  admin: {
    id: String(adminId),
    name: "Fixture Admin",
    email: "admin@example.com",
    role: "admin",
  },
  customer: {
    id: String(customerId),
    name: "Fixture Customer",
    email: "customer@example.com",
    role: "customer",
  },
  technician: {
    id: String(techId),
    name: "Fixture Technician",
    email: "tech@example.com",
    role: "technician",
  },
};
let server, authServer, baseUrl, data, calls, writes, failDB, failAuth;
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) =>
    value instanceof ObjectId
      ? String(row[key]) === String(value)
      : value && typeof value === "object" && "$in" in value
        ? value.$in.includes(row[key])
        : row[key] === value,
  );
}
function project(row, projection) {
  return projection
    ? Object.fromEntries(Object.entries(row).filter(([key]) => projection[key]))
    : { ...row };
}
before(async () => {
  authServer = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (failAuth) {
      res.writeHead(500);
      res.end("{}");
      return;
    }
    const key = req.headers.cookie?.replace("fixture=", "");
    const user = identities[key === "expired" ? "admin" : key];
    res.end(
      JSON.stringify(
        user
          ? {
              user,
              session: {
                userId: user.id,
                expiresAt:
                  key === "expired"
                    ? "2000-01-01"
                    : new Date(Date.now() + 60000),
              },
            }
          : null,
      ),
    );
  });
  authServer.listen(0, "127.0.0.1");
  await once(authServer, "listening");
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${authServer.address().port}`;
  mock.method(MongoClient.prototype, "connect", async () => {});
  mock.method(MongoClient.prototype, "close", async () => {});
  mock.method(MongoClient.prototype, "db", () => ({
    command: async () => ({ ok: 1 }),
    collection: (name) => {
      function access() {
        calls++;
        assert.notEqual(name, "users");
        if (failDB) throw new Error("private-db-secret");
        return data[name];
      }
      return {
        collectionName: name,
        countDocuments: async (filter) =>
          access().filter((row) => matches(row, filter)).length,
        find: (filter, options) => {
          let rows = access().filter((row) => matches(row, filter));
          const cursor = {
            sort(sort) {
              rows.sort((a, b) => {
                for (const [key, direction] of Object.entries(sort)) {
                  const av = a[key],
                    bv = b[key];
                  if (av > bv) return direction;
                  if (av < bv) return -direction;
                }
                return 0;
              });
              return cursor;
            },
            limit(n) {
              rows = rows.slice(0, n);
              return cursor;
            },
            async toArray() {
              return rows.map((row) => project(row, options?.projection));
            },
          };
          return cursor;
        },
        findOne: async (filter, options) => {
          const row = access().find((row) => matches(row, filter));
          return row ? project(row, options?.projection) : null;
        },
        findOneAndUpdate: async (filter, update, options) => {
          const row = access().find((row) => matches(row, filter));
          assert.deepEqual(Object.keys(update.$set).sort(), [
            "role",
            "updatedAt",
          ]);
          assert.ok(update.$set.updatedAt instanceof Date);
          if (!row) return null;
          writes++;
          Object.assign(row, update.$set);
          return project(row, options.projection);
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
  data = {
    user: Object.values(identities).map((user) => ({
      _id: new ObjectId(user.id),
      name: user.name,
      email: user.email,
      role: user.role,
      image: null,
      createdAt: new Date("2026-11-01"),
      password: "secret",
      token: "secret",
    })),
    services: [],
    bookings: [],
    payments: [],
  };
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => authServer.close(resolve));
  await closeDB();
  mock.restoreAll();
});
function request(path, who = "admin", body) {
  return fetch(`${baseUrl}/api/admin/${path}`, {
    method: body === undefined ? "GET" : "PATCH",
    headers: {
      ...(who ? { Cookie: `fixture=${who}` } : {}),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const paths = ["overview", "users", "bookings", "payments"];
test("all admin endpoints deny guests, invalid/expired sessions and non-admin roles before DB access", async () => {
  for (const [who, status] of [
    [null, 401],
    ["bad", 401],
    ["expired", 401],
    ["customer", 403],
    ["technician", 403],
  ]) {
    for (const path of paths)
      assert.equal((await request(path, who)).status, status);
    assert.equal(
      (await request(`users/${customerId}/role`, who, { role: "technician" }))
        .status,
      status,
    );
  }
  assert.equal(calls, 0);
  assert.equal(writes, 0);
});
test("auth outages fail closed for every new endpoint", async () => {
  failAuth = true;
  for (const path of paths) assert.equal((await request(path)).status, 503);
  assert.equal(
    (await request(`users/${customerId}/role`, "admin", { role: "technician" }))
      .status,
    503,
  );
  assert.equal(calls, 0);
});
test("overview empty collections return exact zeros and no claimed revenue", async () => {
  data.user = [];
  const response = await request("overview");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  const result = (await response.json()).data;
  assert.deepEqual(Object.values(result.counts), Array(8).fill(0));
  assert.deepEqual(result.latestServices, []);
  assert.deepEqual(result.latestBookings, []);
  assert.equal(result.paymentRecordCount, 0);
  assert.equal(result.payments.verificationAvailable, true);
  assert.deepEqual(result.payments.revenue, []);
});
test("overview counts exact status groups and latest five by createdAt; completion is not payment", async () => {
  for (let i = 0; i < 9; i++) {
    data.services.push({
      _id: new ObjectId(),
      title: `Service ${i}`,
      approvalStatus: i % 2 ? "approved" : "pending",
      createdAt: new Date(2026, 10, i + 1),
    });
    data.bookings.push({
      _id: new ObjectId(),
      serviceTitle: `Booking ${i}`,
      status: [
        "requested",
        "accepted",
        "in-progress",
        "completed",
        "cancelled",
        "rejected",
        "accepted",
        "in-progress",
        "completed",
      ][i],
      createdAt: new Date(2026, 10, i + 1),
      privateSecret: "hidden",
    });
  }
  data.payments.push({
    _id: new ObjectId(),
    amount: 999,
    currency: "usd",
    paymentStatus: "paid",
  });
  const result = (await (await request("overview?role=customer")).json()).data;
  assert.deepEqual(result.counts, {
    totalUsers: 3,
    totalCustomers: 1,
    totalTechnicians: 1,
    totalServices: 9,
    pendingServiceApprovals: 5,
    totalBookings: 9,
    activeBookings: 4,
    completedBookings: 2,
  });
  assert.deepEqual(
    result.latestServices.map((row) => row.title),
    [8, 7, 6, 5, 4].map((i) => `Service ${i}`),
  );
  assert.deepEqual(
    result.latestBookings.map((row) => row.serviceTitle),
    [8, 7, 6, 5, 4].map((i) => `Booking ${i}`),
  );
  assert.ok(result.latestBookings.every((row) => !row.privateSecret));
  assert.equal(result.paymentRecordCount, 1);
  assert.deepEqual(result.payments.revenue, []);
  assert.equal(writes, 0);
});
test("users read singular BetterAuth user collection with a safe projection", async () => {
  assert.equal(getCollections().usersCollection.collectionName, "user");
  const response = await request("users");
  assert.equal(response.status, 200);
  const users = (await response.json()).data;
  assert.equal(users.length, 3);
  assert.ok(
    users.every(
      (user) => !user.password && !user.token && user.email && user.createdAt,
    ),
  );
  assert.equal(writes, 0);
});
test("customer -> technician -> customer changes only role/updatedAt and preserves auth relations", async () => {
  const original = { ...data.user[1] };
  for (const role of ["technician", "customer"]) {
    const response = await request(`users/${customerId}/role`, "admin", {
      role,
    });
    assert.equal(response.status, 200);
    const result = (await response.json()).data;
    assert.equal(result.role, role);
    assert.equal(result.token, undefined);
    const { updatedAt, ...rest } = data.user[1];
    assert.ok(updatedAt instanceof Date);
    assert.deepEqual(rest, { ...original, role });
  }
  assert.equal(writes, 2);
});
test("role endpoint validates ObjectId and exact whitelist before DB, rejects admin promotion", async () => {
  assert.equal(
    (await request("users/bad/role", "admin", { role: "customer" })).status,
    400,
  );
  for (const body of [
    null,
    [],
    {},
    { role: "admin" },
    { role: "Customer" },
    { role: "technician", email: "spoof@example.com" },
    { role: "customer", name: "changed" },
  ]) {
    assert.equal(
      (await request(`users/${customerId}/role`, "admin", body)).status,
      400,
    );
  }
  assert.equal(calls, 0);
  assert.equal(writes, 0);
});
test("admin cannot change own role, including uppercase ID, nor demote another admin", async () => {
  assert.equal(
    (
      await request(`users/${String(adminId).toUpperCase()}/role`, "admin", {
        role: "customer",
      })
    ).status,
    403,
  );
  assert.equal(calls, 0);
  const other = new ObjectId();
  data.user.push({ _id: other, role: "admin" });
  assert.equal(
    (await request(`users/${other}/role`, "admin", { role: "technician" }))
      .status,
    403,
  );
  assert.equal(writes, 0);
});
test("missing user returns 404 without creating a new user", async () => {
  assert.equal(
    (
      await request(`users/${new ObjectId()}/role`, "admin", {
        role: "customer",
      })
    ).status,
    404,
  );
  assert.equal(writes, 0);
});
test("current trusted role is reread on the next request after a role change", async () => {
  const before = identities.customer.role;
  identities.customer.role = "technician";
  assert.equal((await request("overview", "customer")).status, 403);
  identities.customer.role = before;
  assert.equal(calls, 0);
});
test("bookings are newest first, read-only, project only existing business fields", async () => {
  data.bookings = [1, 2, 3].map((i) => ({
    _id: new ObjectId(),
    serviceTitle: `Repair ${i}`,
    customerEmail: "customer@example.com",
    technicianName: "Fixture Technician",
    preferredDate: new Date("2026-12-01"),
    status: "requested",
    basePrice: 20,
    finalAmount: 25,
    paymentStatus: "unpaid",
    problemDescription: "No cooling",
    createdAt: new Date(2026, 10, i),
    token: "secret",
  }));
  const records = (await (await request("bookings?customerEmail=spoof")).json())
    .data;
  assert.deepEqual(
    records.map((row) => row.serviceTitle),
    ["Repair 3", "Repair 2", "Repair 1"],
  );
  assert.equal(records[0].token, undefined);
  assert.equal(records[0].problemDescription, "No cooling");
  assert.equal(records[0].finalAmount, 25);
  assert.equal(writes, 0);
  assert.equal(
    (
      await request(`bookings/${records[0]._id}/status`, "admin", {
        status: "completed",
      })
    ).status,
    404,
  );
});
test("payments empty and stored paid/mixed currencies never become verified revenue without verified Stripe evidence", async () => {
  let report = (await (await request("payments")).json()).data;
  assert.deepEqual(report.records, []);
  assert.equal(report.verificationAvailable, true);
  data.payments = ["usd", "bdt"].map((currency, i) => ({
    _id: new ObjectId(),
    amount: 25 + i,
    currency,
    transactionId: `fixture-${i}`,
    paymentStatus: "paid",
    paidAt: new Date(2026, 10, i + 1),
    privateSecret: "hidden",
  }));
  report = (await (await request("payments")).json()).data;
  assert.equal(report.records.length, 2);
  assert.equal(report.records[0].currency, "bdt");
  assert.equal(report.records[0].privateSecret, undefined);
  assert.deepEqual(report.revenue, []);
  assert.equal(report.verificationAvailable, true);
  assert.equal(writes, 0);
});
test("all reads and role mutation hide database errors", async () => {
  failDB = true;
  for (const path of paths) {
    const response = await request(path);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private-db-secret/);
  }
  assert.equal(
    (await request(`users/${customerId}/role`, "admin", { role: "technician" }))
      .status,
    500,
  );
  assert.equal(writes, 0);
});
