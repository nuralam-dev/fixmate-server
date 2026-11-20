import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, mock, test } from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import app from "../src/app.js";
import { connectDB, closeDB } from "../src/config/db.js";

let server, authServer, baseUrl;
let records, calls, writes, failDB, failAuth;
let service, indexReady, sessionCount, serviceWrites, failInsert;
const serviceId = new ObjectId();
const session = { fixture: true };
const valid = {serviceId:serviceId.toHexString(),customerPhone:"01700000000",address:"Fixture address",preferredDate:"2099-12-01",problemDescription:"Fixture repair problem"};
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
  let transaction = Promise.resolve();
  mock.method(MongoClient.prototype, "withSession", async work => work(Object.assign(session,{
    withTransaction: work => {
      const run = transaction.then(async () => {
        sessionCount++;
        const previousRecords = structuredClone(records);
        const revision = service.bookingRevision;
        try { return await work(session); }
        catch (error) { records = previousRecords; service.bookingRevision = revision; throw error; }
      });
      transaction = run.catch(() => {});
      return run;
    },
  })));
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
        listIndexes: () => { access(); return {toArray:async()=>indexReady?[{key:{customerEmail:1,serviceId:1},unique:true,partialFilterExpression:{status:{$in:["requested","accepted","in-progress"]}}}]:[]}; },
        insertOne: async (record,options) => {
          access(); assert.equal(options.session,session);
          if(failInsert)throw new Error("private-insert-details");
          if(records.some(b=>b.customerEmail===record.customerEmail&&b.serviceId===record.serviceId&&["requested","accepted","in-progress"].includes(b.status))) {
            const error=new Error("duplicate");error.code=11000;throw error;
          }
          records.push(record);writes++;return {insertedId:record._id};
        },
        find: filter => {
          access();
          assert.deepEqual(Object.keys(filter), [filter.technicianEmail ? "technicianEmail" : "customerEmail"]);
          return { sort: sort => {
            assert.deepEqual(sort, { createdAt: -1, _id: -1 });
            return { toArray: async () => records.filter(record => matches(record, filter))
              .sort((a, b) => b.createdAt - a.createdAt) };
          } };
        },
        findOne: async filter => { access(); return records.find(record => matches(record, filter)) || null; },
        findOneAndUpdate: async (filter, update, options) => {
          if(name === "services") {
            calls++;
            if(failDB)throw new Error("private-database-details");
            assert.equal(options.session,session);
            assert.deepEqual(filter,{_id:serviceId,approvalStatus:"approved",isAvailable:true});
            assert.deepEqual(update,{$inc:{bookingRevision:1}});
            assert.equal(options.returnDocument,"after");
            if(!service||service.approvalStatus!=="approved"||!service.isAvailable)return null;
            service.bookingRevision=(service.bookingRevision||0)+1;serviceWrites++;
            return {...service};
          }
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
  calls = writes = sessionCount = serviceWrites = 0;
  indexReady=true;failInsert=false;
  service={_id:serviceId,title:"Stored AC repair",image:"https://example.com/ac.png",category:"AC",technicianName:"Stored Technician",technicianEmail:identities.technician.email,basePrice:75.5,approvalStatus:"approved",isAvailable:true};
  failDB = failAuth = false;
  records = [];
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



function post(who="a",body=valid) { return request("POST",who,body,""); }
test("POST creates trusted snapshot/defaults, then Customer and Technician see the same booking",async()=>{
 const response=await post();assert.equal(response.status,201);assert.match(response.headers.get("cache-control"),/no-store/);
 const {data}=await response.json();assert.equal(data.customerEmail,identities.a.email);assert.equal(data.customerName,identities.a.name);
 assert.equal(data.technicianEmail,service.technicianEmail);assert.equal(data.technicianName,service.technicianName);
 assert.equal(data.basePrice,75.5);assert.equal(data.finalAmount,null);assert.equal(data.status,"requested");assert.equal(data.paymentStatus,"unpaid");
 assert.equal(data.serviceId,serviceId.toHexString());assert.equal(data.serviceTitle,service.title);assert.equal(data.serviceImage,service.image);
 assert.equal(data.preferredDate,"2099-12-01T00:00:00.000Z");assert.ok(records[0].createdAt instanceof Date);
 assert.equal(writes,1);assert.equal(sessionCount,1);assert.equal(service.bookingRevision,1);
 assert.equal((await(await request()).json()).data[0]._id,data._id);
 const r=await request("GET","technician",undefined,"/technician");assert.equal(r.status,200);assert.equal((await r.json()).data[0]._id,data._id);
});
test("guest/expired/invalid sessions give 401 and technician/admin give 403 before reads",async()=>{
 for(const [who,status]of [[null,401],["invalid",401],["expired",401],["technician",403],["admin",403]])assert.equal((await post(who)).status,status);
 assert.equal(calls,0);assert.equal(writes,0);
});
test("auth service failures remain safe and fail closed",async()=>{failAuth=true;assert.equal((await post()).status,503);assert.equal(calls,0)});
test("invalid/protected payloads are 400 without database access",async()=>{
 for(const body of [null,[],{}, {...valid,customerEmail:identities.b.email},{...valid,role:"customer"},{...valid,basePrice:1},{...valid,status:"accepted"},{...valid,serviceId:"bad"},{...valid,serviceId:valid.serviceId+"\n"},{...valid,customerPhone:"abcdef"},{...valid,address:" "},{...valid,problemDescription:" "},{...valid,preferredDate:"2026-02-30"},{...valid,preferredDate:"2000-01-01"},{...valid,preferredDate:"bad"},{...valid,address:"a".repeat(501)}])assert.equal((await post("a",body)).status,400);
 assert.equal(calls,0);assert.equal(writes,0);
});
test("unapproved/unavailable/missing service cannot create a booking",async()=>{
 for(const state of ["pending","rejected","unavailable","missing"]){service.approvalStatus=state==="missing"?"approved":state;service.isAvailable=state!=="unavailable";if(state==="missing")service.approvalStatus="missing";assert.equal((await post()).status,404)}
 assert.equal(writes,0);
});
test("missing unique index fails closed with 503 and no transaction/write",async()=>{indexReady=false;assert.equal((await post()).status,503);assert.equal(sessionCount,0);assert.equal(writes,0)});
test("sequential and concurrent duplicate creation return 409 with one record",async()=>{
 const responses=await Promise.all([post(),post()]);assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);assert.equal(records.length,1);assert.equal((await post()).status,409);assert.equal(records.length,1);assert.equal(service.bookingRevision,1);
});
test("active accepted and in-progress also block duplicates",async()=>{
 await post();for(const status of ["accepted","in-progress"]){records[0].status=status;assert.equal((await post()).status,409)}assert.equal(records.length,1);
});
test("different customer can book the same service; GET stays isolated",async()=>{
 assert.equal((await post()).status,201);assert.equal((await post("b")).status,201);
 assert.equal((await(await request()).json()).data.length,1);assert.equal((await(await request("GET","b")).json()).data.length,1);
});
test("cancellation releases active booking constraint and preserves history",async()=>{
 const created=await(await post()).json();assert.equal((await request("PATCH","a",{},`/${created.data._id}/cancel`)).status,200);
 assert.equal((await post()).status,201);assert.equal(records.length,2);assert.equal(records[0].status,"cancelled");
});
test("transaction insert failure rolls back service revision and leaks no details",async()=>{
 failInsert=true;const r=await post();assert.equal(r.status,500);assert.doesNotMatch(await r.text(),/private-insert/);assert.equal(records.length,0);assert.equal(service.bookingRevision,undefined);
});
test("DB failure returns safe 500 with no booking",async()=>{failDB=true;const r=await post();assert.equal(r.status,500);assert.doesNotMatch(await r.text(),/private-database/);assert.equal(records.length,0)});
