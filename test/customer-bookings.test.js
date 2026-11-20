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
  a: { id: "a", name: "Customer A", email: "a@example.com", role: "customer" },
  b: { id: "b", name: "Customer B", email: "b@example.com", role: "customer" },
  technician: { id: "c", name: "Technician", email: "c@example.com", role: "technician" },
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
          assert.deepEqual(Object.keys(filter), ["customerEmail"]);
          return { sort: sort => {
            assert.deepEqual(sort, { createdAt: -1, _id: -1 });
            return { toArray: async () => records.filter(record => matches(record, filter))
              .sort((a, b) => b.createdAt - a.createdAt) };
          } };
        },
        findOne: async filter => { access(); return records.find(record => matches(record, filter)) || null; },
        findOneAndUpdate: async (filter, update, options) => {
          access();
          assert.deepEqual(Object.keys(filter).sort(), ["_id", "status", filter.technicianEmail ? "technicianEmail" : "customerEmail"].sort());
          assert.equal(filter.status, "requested");
          assert.ok(filter._id instanceof ObjectId);
          assert.deepEqual(options, { returnDocument: "after" });
          assert.deepEqual(Object.keys(update), ["$set"]);
          assert.deepEqual(Object.keys(update.$set).sort(), ["status", "updatedAt"]);
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
    _id: id, customerEmail: identities.a.email, status: "requested",
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
  return fetch(`${baseUrl}/api/bookings${path ?? (method === "GET" ? "/my" : `/${id}/cancel`)}`, {
    method,
    headers: { ...(who ? { Cookie: `fixture=${who}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}


test("GET isolates customers, includes six statuses, newest first and ignores submitted identity", async () => {
  for (const [index,status] of ["accepted","in-progress","completed","rejected","cancelled"].entries()) {
    records.push({...records[0], _id:new ObjectId(),status,createdAt:new Date(2026,10,index+2)});
  }
  records.push({...records[0],_id:new ObjectId(),customerEmail:identities.b.email});
  const response=await request("GET","a",undefined,"/my?customerEmail=b@example.com&role=admin");
  assert.equal(response.status,200);
  assert.match(response.headers.get("cache-control"),/private, no-store/);
  const result=await response.json();
  assert.equal(result.success,true);
  assert.equal(result.data.length,6);
  assert.ok(result.data.every(b=>b.customerEmail===identities.a.email));
  assert.deepEqual(result.data.map(b=>b.status),["cancelled","rejected","completed","in-progress","accepted","requested"]);
  assert.equal((await (await request("GET","b")).json()).data.length,1);
});
test("GET empty array and refreshed cancellation",async()=>{
  assert.deepEqual((await(await request("GET","b")).json()).data,[]);
  await request("PATCH","a",{});
  assert.equal((await(await request()).json()).data[0].status,"cancelled");
});
test("GET/cancel reject guests, invalid/expired sessions, technician and admin before DB reads",async()=>{
  for(const method of ["GET","PATCH"])for(const [who,status] of [[null,401],["invalid",401],["expired",401],["technician",403],["admin",403]]) {
    assert.equal((await request(method,who,method==="PATCH"?{}:undefined)).status,status);
  }
  assert.equal(calls,0);
});
test("auth failure is safe 503 and does not access MongoDB",async()=>{
  failAuth=true;
  for(const method of ["GET","PATCH"])assert.equal((await request(method,"a",method==="PATCH"?{}:undefined)).status,503);
  assert.equal(calls,0);
});
test("cancel atomically changes only status and updatedAt, never deletes",async()=>{
  const original={...records[0]};
  const response=await request("PATCH","a",{});
  assert.equal(response.status,200);
  assert.match(response.headers.get("cache-control"),/private, no-store/);
  assert.equal((await response.json()).data.status,"cancelled");
  assert.equal(records.length,1);
  assert.equal(writes,1);
  const {updatedAt,...unchanged}=records[0];
  assert.ok(updatedAt instanceof Date);
  assert.deepEqual(unchanged,{...original,status:"cancelled"});
});
test("invalid IDs and protected payloads are 400 without reads",async()=>{
  for(const id of ["bad","123","g".repeat(24)])assert.equal((await request("PATCH","a",{},`/${id}/cancel`)).status,400);
  for(const body of [null,[],{customerEmail:identities.b.email},{status:"cancelled"},{role:"customer"},{paymentStatus:"paid"}])assert.equal((await request("PATCH","a",body)).status,400);
  assert.equal(calls,0);
});
test("other customer and missing booking both return 404 with no writes",async()=>{
  assert.equal((await request("PATCH","b",{})).status,404);
  assert.equal((await request("PATCH","a",{},`/${new ObjectId()}/cancel`)).status,404);
  assert.equal(writes,0);
});
test("all processed statuses return 409, including accepted/completed",async()=>{
  for(const status of ["accepted","in-progress","completed","rejected","cancelled"]){
    records[0].status=status;
    assert.equal((await request("PATCH","a",{})).status,409);
    assert.equal(records[0].status,status);
  }
  assert.equal(writes,0);
});
test("concurrent cancellations produce exactly one write",async()=>{
  const responses=await Promise.all([request("PATCH","a",{}),request("PATCH","a",{})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal(writes,1);
});
test("cancel racing technician accept cannot both succeed",async()=>{
  records[0].technicianEmail=identities.technician.email;
  const responses=await Promise.all([
    request("PATCH","a",{}),
    request("PATCH","technician",{status:"accepted"},`/${id}/status`),
  ]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal(writes,1);
  assert.ok(["accepted","cancelled"].includes(records[0].status));
});
test("GET/cancel DB errors use safe existing handler",async()=>{
  failDB=true;
  for(const method of ["GET","PATCH"]){
    const r=await request(method,"a",method==="PATCH"?{}:undefined);
    assert.equal(r.status,500);
    assert.doesNotMatch(await r.text(),/private-database-details/);
  }
  assert.equal(writes,0);
});
