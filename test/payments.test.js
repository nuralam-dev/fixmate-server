import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, mock, test } from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";
import app from "../src/app.js";
import { connectDB, closeDB } from "../src/config/db.js";

let server, authServer, base, records, payments, sessions, calls, created, failDB, ready, badStripe, failUpdate;
const id = new ObjectId();
const secret = "whsec_fixture_payment_tests_only";
const stripe = new Stripe("sk_test_fixture");
const users = {
  a: { id: "customer-a", email: "a@example.test", name: "Customer A", role: "customer" },
  b: { id: "customer-b", email: "b@example.test", name: "Customer B", role: "customer" },
  technician: { id: "tech", email: "tech@example.test", name: "Technician", role: "technician" },
  admin: { id: "admin", email: "admin@example.test", name: "Admin", role: "admin" },
};
function match(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && "$exists" in value) return (record[key] !== undefined) === value.$exists;
    if (key === "_id") return record._id.equals(value);
    return record[key] === value;
  });
}
before(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  process.env.CLIENT_URL = "http://localhost:3000";
  authServer = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const who = req.headers.cookie?.replace("fixture=", "");
    const user = users[who] || (who === "expired" ? users.a : null);
    res.end(JSON.stringify(user ? { user, session: { userId: user.id, expiresAt: who === "expired" ? "2000-01-01" : new Date(Date.now() + 60000).toISOString() } } : null));
  });
  authServer.listen(0, "127.0.0.1"); await once(authServer, "listening");
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${authServer.address().port}`;
  mock.method(MongoClient.prototype, "connect", async () => {});
  mock.method(MongoClient.prototype, "close", async () => {});
  let transaction = Promise.resolve();
  const session = { withTransaction(work) {
    const run = transaction.then(async () => {
      const oldRecords = records.map(record => ({ ...record }));
      const oldPayments = payments.map(record => ({ ...record }));
      try { return await work(); } catch (error) { records = oldRecords; payments = oldPayments; throw error; }
    });
    transaction = run.catch(() => {}); return run;
  } };
  mock.method(MongoClient.prototype, "withSession", async work => work(session));
  mock.method(MongoClient.prototype, "db", () => ({ command: async () => ({ ok: 1 }), collection(name) {
    const source = () => {
      calls++; if (failDB) throw new Error("private-db-details");
      assert.ok(["bookings", "payments"].includes(name));
      return name === "bookings" ? records : payments;
    };
    function update(record, change) {
      if (change.$set) Object.assign(record, change.$set);
      for (const key of Object.keys(change.$unset || {})) delete record[key];
    }
    return {
      listIndexes: () => ({ toArray: async () => { source(); return ready ? ["bookingId", "stripeSessionId", "transactionId"].map(field => ({ key: { [field]: 1 }, unique: true, partialFilterExpression: { verified: true } })) : []; } }),
      findOne: async (filter, options) => { if (options?.session) assert.equal(options.session, session); return source().find(record => match(record, filter)) || null; },
      find: filter => ({ sort: () => ({ toArray: async () => source().filter(record => match(record, filter)).sort((a, b) => b.paidAt - a.paidAt) }) }),
      findOneAndUpdate: async (filter, change) => { const record = source().find(record => match(record, filter)); if (!record) return null; update(record, change); return { ...record }; },
      updateOne: async (filter, change, options) => {
        if (options?.session) assert.equal(options.session, session);
        const record = source().find(record => match(record, filter));
        if (!record || failUpdate) return { matchedCount: 0, modifiedCount: 0 };
        update(record, change); return { matchedCount: 1, modifiedCount: 1 };
      },
      insertOne: async (record, options) => {
        assert.equal(name, "payments"); assert.equal(options.session, session);
        if (payments.some(item => item.bookingId === record.bookingId || item.stripeSessionId === record.stripeSessionId || item.transactionId === record.transactionId)) { const error = new Error("duplicate"); error.code = 11000; throw error; }
        source().push({ _id: new ObjectId(), ...record }); return { insertedId: payments.at(-1)._id };
      },
    };
  } }));
  const checkout = Object.getPrototypeOf(stripe.checkout.sessions);
  mock.method(checkout, "create", async (body, options) => {
    assert.equal(body.line_items[0].price_data.unit_amount, 1250);
    assert.equal(body.line_items[0].price_data.currency, "usd");
    assert.equal(body.client_reference_id, id.toHexString());
    assert.equal(body.customer_email, users.a.email);
    assert.equal(body.metadata.bookingId, id.toHexString());
    assert.equal(body.success_url, "http://localhost:3000/payment/success?session_id={CHECKOUT_SESSION_ID}");
    const key = options.idempotencyKey;
    if (!sessions.has(key)) {
      created++;
      sessions.set(key, { id: `cs_test_fixture${created}`, url: `https://checkout.stripe.com/c/pay/cs_test_fixture${created}`,
        mode: "payment", status: "open", payment_status: "unpaid", amount_total: 1250, currency: "usd", livemode: false,
        client_reference_id: body.client_reference_id, customer_email: body.customer_email, metadata: { ...body.metadata },
        payment_intent: { id: `pi_fixture${created}`, livemode: false, status: "requires_payment_method", amount_received: 0, currency: "usd", metadata: { ...body.payment_intent_data.metadata } } });
    }
    return { ...sessions.get(key), ...(badStripe ? { livemode: true } : {}) };
  });
  mock.method(checkout, "retrieve", async sessionId => {
    const found = [...sessions.values()].find(value => value.id === sessionId);
    if (!found) throw new Error("private-stripe-details");
    return { ...found, payment_intent: { ...found.payment_intent } };
  });
  await connectDB(); server = app.listen(0, "127.0.0.1"); await once(server, "listening"); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  calls = created = 0; failDB = badStripe = failUpdate = false; ready = true;
  sessions = new Map(); payments = [];
  records = [{ _id: id, serviceTitle: "Fixture Repair", customerEmail: users.a.email, customerName: users.a.name,
    technicianEmail: users.technician.email, technicianName: users.technician.name, status: "completed", paymentStatus: "unpaid", finalAmount: 12.5 }];
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (authServer) await new Promise(resolve => authServer.close(resolve));
  await closeDB(); mock.restoreAll();
});
function request(path = "create-checkout-session", who = "a", body = { bookingId: id.toHexString() }, method = "POST") {
  return fetch(`${base}/api/payments/${path}`, { method, headers: { ...(who ? { Cookie: `fixture=${who}` } : {}), "Content-Type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });
}
async function paidCheckout() {
  assert.equal((await request()).status, 200);
  const checkout = [...sessions.values()][0]; checkout.status = "complete"; checkout.payment_status = "paid";
  checkout.payment_intent.status = "succeeded"; checkout.payment_intent.amount_received = 1250;
  return checkout;
}
function webhook(checkout, options = {}) {
  const payload = JSON.stringify({ id: "evt_fixture", created: Math.floor(Date.now() / 1000), type: "checkout.session.completed", livemode: false,
    data: { object: checkout }, ...options });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return fetch(`${base}/api/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": signature }, body: payload });
}
test("Checkout denies missing/invalid/expired sessions and wrong roles before DB reads", async () => {
  for (const [who, status] of [[null, 401], ["invalid", 401], ["expired", 401], ["technician", 403], ["admin", 403]]) assert.equal((await request(undefined, who)).status, status);
  assert.equal(calls, 0);
});
test("Checkout validates ID and refuses submitted amount/identity", async () => {
  for (const body of [null, [], {}, { bookingId: "bad" }, { bookingId: id.toHexString(), amount: 1 }, { bookingId: id.toHexString(), customerEmail: users.b.email }]) assert.equal((await request(undefined, "a", body)).status, 400);
  assert.equal(calls, 0);
});
test("only owned completed unpaid bookings with valid USD amounts can start Checkout", async () => {
  assert.equal((await request(undefined, "b")).status, 404);
  for (const status of ["requested", "accepted", "in-progress", "cancelled", "rejected"]) { records[0].status = status; assert.equal((await request()).status, 409); }
  records[0].status = "completed"; records[0].paymentStatus = "paid"; assert.equal((await request()).status, 409);
  records[0].paymentStatus = "unpaid";
  for (const amount of [null, 0, -1, 0.49, 1.005, 1000000]) { records[0].finalAmount = amount; assert.equal((await request()).status, 400); }
  assert.equal(created, 0);
});
test("Checkout uses DB amount, stores server linkage, reuses sessions and prevents concurrent duplicates", async () => {
  const responses = await Promise.all([request(), request()]); assert.ok(responses.every(r => r.status === 200));
  assert.equal(created, 1); assert.equal(records[0].checkoutAmount, 1250); assert.equal(records[0].checkoutCurrency, "usd");
  const again = await request(); assert.equal(again.status, 200); assert.equal(created, 1); assert.equal((await again.json()).data.url, "https://checkout.stripe.com/c/pay/cs_test_fixture1");
});
test("expired Checkout can be renewed but completed Checkout cannot double charge", async () => {
  await request(); [...sessions.values()][0].status = "expired"; assert.equal((await request()).status, 200); assert.equal(created, 2);
  [...sessions.values()][1].status = "complete"; assert.equal((await request()).status, 409); assert.equal(created, 2);
});
test("payment setup missing, live key/response and DB failures fail closed", async () => {
  ready = false; assert.equal((await request()).status, 503); ready = true;
  process.env.STRIPE_SECRET_KEY = "sk_live_fixture"; assert.equal((await request()).status, 503); process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
  badStripe = true; assert.equal((await request()).status, 503); badStripe = false;
  failDB = true; const response = await request(); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private/);
});
test("raw webhook rejects invalid signatures and live events, ignores unrelated CLI fixtures", async () => {
  const r = await fetch(`${base}/api/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": "bad" }, body: "{}" });
  assert.equal(r.status, 400); assert.equal(calls, 0);
  assert.equal((await webhook({}, { livemode: true })).status, 400);
  assert.equal((await webhook({ id: "cs_test_unrelated", metadata: {} })).status, 200); assert.equal(payments.length, 0);
});
test("signed paid Checkout creates one verified payment and atomically marks owned booking paid", async () => {
  const checkout = await paidCheckout(); const response = await webhook(checkout); assert.equal(response.status, 200);
  assert.equal(records[0].paymentStatus, "paid"); assert.equal(payments.length, 1);
  assert.equal(payments[0].amount, 12.5); assert.equal(payments[0].currency, "usd"); assert.equal(payments[0].verified, true); assert.equal(payments[0].testMode, true);
  assert.equal(payments[0].customerEmail, users.a.email); assert.equal(payments[0].bookingId, id.toHexString());
});
test("repeated and concurrent webhook deliveries never duplicate payments", async () => {
  const checkout = await paidCheckout(); const responses = await Promise.all([webhook(checkout), webhook(checkout), webhook(checkout)]);
  assert.ok(responses.every(r => r.status === 200)); assert.equal(payments.length, 1);
  assert.equal((await webhook(checkout)).status, 200); assert.equal(payments.length, 1);
});
test("amount/currency/customer/metadata/session mismatches and unpaid intents cannot mark paid", async () => {
  for (const change of [c => c.amount_total++, c => c.currency = "bdt", c => c.customer_email = users.b.email,
    c => c.metadata.checkoutRequestId = "foreign", c => c.client_reference_id = "foreign", c => c.payment_status = "unpaid",
    c => c.payment_intent.status = "processing", c => c.payment_intent.amount_received = 1, c => c.payment_intent.livemode = true]) {
    sessions = new Map(); records[0] = { ...records[0], paymentStatus: "unpaid" }; delete records[0].stripeSessionId; delete records[0].checkoutRequestId;
    const checkout = await paidCheckout(); change(checkout); assert.equal((await webhook(checkout)).status, 400); assert.equal(payments.length, 0); assert.equal(records[0].paymentStatus, "unpaid");
  }
});
test("failed booking update rolls back inserted payment", async () => {
  const checkout = await paidCheckout(); failUpdate = true; assert.equal((await webhook(checkout)).status, 503); assert.equal(payments.length, 0); assert.equal(records[0].paymentStatus, "unpaid");
});
test("Customer history/session read is owner-scoped and admin reports verified totals only", async () => {
  const checkout = await paidCheckout(); await webhook(checkout);
  let r = await request("my", "a", undefined, "GET"); assert.equal(r.status, 200); let report = (await r.json()).data; assert.equal(report.records.length, 1); assert.deepEqual(report.revenue, [{ currency: "usd", amount: 12.5 }]);
  assert.equal((await(await request("my?customerEmail=a@example.test", "b", undefined, "GET")).json()).data.records.length, 0);
  assert.equal((await request(`session/${checkout.id}`, "b", undefined, "GET")).status, 404);
  assert.equal((await(await request(`session/${checkout.id}`, "a", undefined, "GET")).json()).data.paid, true);
  payments.push({ _id: new ObjectId(), amount: 999, currency: "usd", paymentStatus: "paid", customerEmail: users.a.email });
  r = await fetch(base + "/api/admin/payments", { headers: { Cookie: "fixture=admin" } }); report = (await r.json()).data;
  assert.equal(report.records.length, 2); assert.deepEqual(report.revenue, [{ currency: "usd", amount: 12.5 }]);
});
