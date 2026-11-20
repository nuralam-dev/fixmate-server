import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import express from "express";
import app from "../src/app.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test("root and public health endpoint return consistent JSON", async () => {
  for (const path of ["/", "/api/health"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await response.json(), { success: true, message: "FixMate API is running" });
    assert.equal(response.headers.get("x-powered-by"), null);
  }
});

test("unknown routes and the old unprotected users endpoint return JSON 404", async () => {
  for (const path of ["/api/missing", "/users"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { success: false, message: "Route not found" });
  }
});

test("unauthenticated service POST is rejected before accessing MongoDB", async () => {
  for (const path of ["/api/services"]) {
    for (const body of [null, [], {}, { title: "   " }]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, body === null ? 400 : 401);
      assert.equal((await response.json()).success, false);
    }
  }
});

test("invalid and oversized JSON return safe errors", async () => {
  for (const [body, status, message] of [
    ['{"broken":', 400, "Invalid JSON body"],
    [JSON.stringify({ value: "x".repeat(110000) }), 413, "Request body is too large"],
  ]) {
    const response = await fetch(`${baseUrl}/api/health`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { success: false, message });
  }
});

test("CORS permits the configured frontend origin and never returns a wildcard", async () => {
  const allowedOrigin = process.env.CLIENT_URL || "http://localhost:3000";
  const response = await fetch(`${baseUrl}/api/health`, {
    method: "OPTIONS",
    headers: { Origin: allowedOrigin, "Access-Control-Request-Method": "GET" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");

  const blockedOrigin = "https://untrusted.example";
  const blocked = await fetch(`${baseUrl}/api/health`, { headers: { Origin: blockedOrigin } });
  assert.notEqual(blocked.headers.get("access-control-allow-origin"), blockedOrigin);
  assert.notEqual(blocked.headers.get("access-control-allow-origin"), "*");
});

test("unexpected async failures return a safe JSON 500", async () => {
  const failingApp = express();
  failingApp.get("/", async () => { throw new Error("private internal detail"); });
  failingApp.use(errorHandler);
  const failingServer = failingApp.listen(0, "127.0.0.1");
  await once(failingServer, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${failingServer.address().port}`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { success: false, message: "Something went wrong" });
  } finally {
    await new Promise(resolve => failingServer.close(resolve));
  }
});
