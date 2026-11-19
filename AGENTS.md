# FixMate Backend — Assignment 9, Category 006

## Project and working rules

FixMate connects customers with technicians for smart device and home appliance
repairs. This is a beginner-friendly JavaScript backend. Keep code simple,
readable, and maintainable; do not over-engineer. Use async/await and meaningful
names. Reuse existing code. Avoid unnecessary libraries, classes, controllers,
repositories, services, custom frameworks, and empty modules.

Explain important changes in simple Bangla. Read files before editing and avoid
unrelated changes. Follow Assignment 9 requirements and the user's current scope.
Do not modify the separate Next.js frontend or its working BetterAuth setup.

## Stack and structure

- Node.js 22 currently available; JavaScript ES Modules (`type: module`).
- Express 5, MongoDB Native Driver, dotenv, cors. No Mongoose or TypeScript.
- `index.js`: dotenv loading, database-first startup, HTTP listen and shutdown.
- `src/app.js`: Express, restricted CORS, JSON parsing, routes, 404/error handlers.
- `src/config/db.js`: one reusable MongoClient, startup connect/ping, getDatabase,
  closeDatabase. Do not reconnect per request.
- `src/middleware/errorHandler.js`: consistent safe JSON errors.
- `src/routes/healthRoutes.js`: public HTTP liveness endpoint.
- `test/app.test.js`: Node built-in tests; HTTP responses, CORS and error paths.
- `npm start`: root `index.js`; `npm run dev`: Node watch mode, no nodemon needed.
- `npm test`: HTTP tests without MongoDB; `npm run check`: source syntax checks.

## Environment and MongoDB

- Private `.env` uses MONGODB_URI and PORT. CLIENT_URL is supported; fallback is
  http://localhost:3000. Default backend port is 4000.
- `.env.example` contains placeholders only. Never print or commit credentials,
  connection strings, tokens, passwords, authentication records, or raw errors
  that may contain secrets. Never log full authentication responses.
- Missing MONGODB_URI or failed initial connection prevents HTTP startup. Startup
  success requires a real MongoDB ping; health GET does not recheck the database.
- Use exact database name `fixmateDB`, previously verified by read-only inspection.
  Do not create a differently capitalized `fixMateDB` or duplicate database.
- BetterAuth actually uses singular `user`, plus `session`, `account`,
  `verification`. The assignment calls the logical application user area `users`;
  do not create a duplicate physical `users` collection or rename auth collections.
- Future application collections: existing `user`, services, bookings, payments.
  No demo data, schema/index changes or collection creation in foundation work.
- A previously exposed credential was reported, but its original fingerprint and
  rotation evidence were not supplied. A successful connection does not prove
  rotation. If replacement is unconfirmed, rotate the exposed credential through
  the database provider; never include it in reports or instructions.

## API conventions and Phase 1 scope

- GET / and GET /api/health return 200 with
  { success: true, message: "FixMate API is running" }.
- /api/health reports HTTP liveness only, not ongoing MongoDB readiness.
- Unknown routes return JSON 404. Malformed JSON returns 400, oversized JSON 413,
  unsupported encoding 415, unexpected failures a generic 500. Never expose stacks.
- Success responses use success:true, message, and data when relevant; errors use
  success:false and message. Use suitable HTTP status codes consistently.
- CORS allows CLIENT_URL (default http://localhost:3000) with credentials. It is
  browser policy, not authentication. Do not replace it with unrestricted CORS.
- The old unauthenticated GET /users read the wrong collection and was removed.
  It now returns the normal JSON 404; do not restore an unprotected user listing.
- Future Stripe webhooks require a raw request body before JSON parsing. Account
  for the current JSON middleware when implementing payments in a later phase.
- Phase 1 is foundation only: no services, bookings, admin, profile, payment,
  Stripe, JWT or BetterAuth implementation. No second authentication system.

## Future authentication and ownership

Exactly three roles: customer, technician, admin. No Branch Manager role.
Implement verifyToken then requireRole in a later authorized phase, using a
verified integration compatible with existing BetterAuth. Current frontend auth
uses database sessions; its opaque session token must not be assumed to be a JWT.
Verify JWT signatures and relevant issuer/audience/expiry claims; never merely
decode a token or invent a separate login/token generation flow.

Resolve authenticated identity and current role from trusted backend/auth data.
Never trust frontend role, customerEmail, technicianEmail, or payment amount for
authorization. Missing/invalid authentication returns 401; wrong role returns 403;
missing resources return 404. Whitelist profile fields and safe response fields.

- Customers access only their own bookings and payments and can cancel requested
  bookings only. They cannot create technician services or change job status.
- Technicians manage only their services and assigned bookings. They cannot
  approve services, manage users or submit customer bookings.
- Admins use authorized user/service/booking/transaction APIs, cannot change their
  own role, and have a read-only all-bookings view. No public admin registration.
- Enforce ownership on every relevant backend read/mutation, not just in the UI.
- Future status pipeline: requested -> accepted/rejected (technician), requested
  -> cancelled (customer), accepted -> in-progress -> completed (technician).
  Completion requires finalAmount > 0; reject other transitions server-side.
- Prevent duplicate active bookings for the same customer/service. Payments are
  allowed only for completed unpaid owned bookings, using MongoDB finalAmount,
  Stripe Test Mode and USD. Only verified Stripe processing may mark paid;
  enforce signature verification and duplicate-payment prevention.

## Verification and handoff

Run syntax and HTTP tests after changes; never claim unexecuted checks passed.
Test real MongoDB startup separately; automated HTTP tests do not connect to it.
Inspect database metadata read-only when authorized. Do not change records just
to test foundation code. Record inaccessible checks and uncertainty honestly.
The backend was not a Git repository at initial inspection; .gitignore rules do
not prove .env is untracked until Git tracking can actually be inspected.

Next phase: verify the BetterAuth-compatible JWT/JWKS contract and implement
verifyToken/requireRole with trusted identity and role lookup. Business modules
remain future work. Stop after the requested phase and wait for user direction.
