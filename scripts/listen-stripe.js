import "dotenv/config";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
  console.error("A Stripe Test Secret Key is required in the backend .env.");
  process.exit(1);
}
// Use the backend's test account for forwarding; never put an API key in argv.
const child = spawn("stripe", ["listen", "--forward-to", "localhost:4000/api/payments/webhook"], {
  env: { ...process.env, STRIPE_API_KEY: process.env.STRIPE_SECRET_KEY }, stdio: ["ignore", "pipe", "pipe"],
});
let received = false;
function line(value) {
  const secret = value.match(/whsec_[A-Za-z0-9]+/)?.[0];
  if (secret && !received) {
    let env = readFileSync(".env", "utf8");
    for (const [key, data] of [["STRIPE_WEBHOOK_SECRET", secret], ["CLIENT_URL", "http://localhost:3000"]]) {
      const line = new RegExp(`^${key}=.*$`, "m");
      if (line.test(env)) env = env.replace(line, `${key}=${data}`);
      else env += `${env.endsWith("\n") ? "" : "\n"}${key}=${data}\n`;
    }
    writeFileSync(".env", env, { mode: 0o600 });
    chmodSync(".env", 0o600);
    received = true;
    console.log("Current listener signing secret saved securely to ignored backend .env. Restart the backend to load it.");
  }
  process.stdout.write(value.replace(/(?:whsec_|[sr]k_(?:test|live)_)[A-Za-z0-9]+/g, "[REDACTED]"));
}
let buffer = "";
function output(chunk) {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const value of lines) line(value + "\n");
}
child.stdout.on("data", output);
child.stderr.on("data", output);
child.on("error", () => { console.error("Could not start Stripe CLI listener."); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code || 0; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
