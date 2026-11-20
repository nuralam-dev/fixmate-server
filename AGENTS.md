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
- `src/config/db.js`: one reusable MongoClient, `connectDB` for startup connect/ping,
  `getDatabase`, `getCollections`, and `closeDatabase`. `connectToDatabase` remains
  an alias for compatibility. Do not reconnect per request.
- `src/middleware/errorHandler.js`: consistent safe JSON errors.
- `src/routes/healthRoutes.js`: public HTTP liveness endpoint.
- `src/routes/users/routes.js`: empty Express Router mounted at `/api/users`.
- `src/routes/services/routes.js`: GET list, GET details and existing POST handlers,
  mounted at `/api/services` and the existing `/services` path.
- `src/routes/bookings/routes.js`: empty Express Router mounted at `/api/bookings`.
- These routers use ES Modules and `export default router`. They have no CRUD
  handlers except the Services GET/POST implementations documented below.
  Future private handlers must use `verifyToken` then `requireRole` and trusted
  backend identity, roles and ownership checks.
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
- Application collections: existing BetterAuth `user`, plus `services` and
  `bookings`, created in the authorized collection setup below. `payments` remains
  future work. No demo data or schema/index changes were made.
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
The backend was not a Git repository at initial inspection, but a repository
appeared during the task. Final Git checks confirmed .env is untracked and
.env/.env.local/.env.production are ignored; .env.example is not ignored.

Next phase: verify the BetterAuth-compatible JWT/JWKS contract and implement
verifyToken/requireRole with trusted identity and role lookup. Business modules
remain future work. Stop after the requested phase and wait for user direction.

## Verified Phase 1 results (2026-11-19)

- Syntax checks passed for all source and test files.
- All five built-in HTTP tests passed: root/health, JSON 404 (including /users),
  invalid/oversized JSON, CORS/preflight, and safe unexpected async error responses.
- The actual root entry point was started with the existing .env; MongoDB connect
  and ping succeeded before HTTP listening. Live health, unknown-route and invalid
  JSON requests returned the expected 200/404/400 JSON responses.
- SIGTERM closed the HTTP server and MongoDB with exit code 0.
- Missing and unreachable MONGODB_URI overrides each prevented HTTP startup and
  exited 1 with a generic message. The private .env file was not modified.
- Fresh read-only database inspection found fixmateDB and only user, session,
  account, verification collections. No collections or records were changed.
- Package dependencies and lockfile were unchanged; no packages were installed.
- No frontend files were changed during Phase 1.
- Final Git checks confirmed .env is untracked, local env files are ignored,
  .env.example is not ignored, and git diff --check passes. Credential rotation
  remains unverified.

## Verified collection setup (2026-11-19)

- Reused `connectToDatabase` and `closeDatabase` from `src/config/db.js` with the
  existing MongoDB Native Driver. Connection and ping succeeded, and the connected
  database name was confirmed as exactly `fixmateDB`.
- Before creation, collection metadata listed `user`, `session`, `account`, and
  `verification`. Only missing `services` and `bookings` were explicitly created.
- After creation, metadata confirmed `user`, `services`, and `bookings` exist.
  Logical `users` means the existing physical BetterAuth `user` collection; no
  physical `users` collection or duplicate database was created.
- Existing documents, BetterAuth fields, collection options, validators and
  indexes were left unchanged. No dummy documents were inserted. No APIs,
  authentication, frontend, dependencies or application startup code were changed.
- Setup ran as a one-time script outside the project using the existing private
  environment file without printing credentials or user records. Collection
  creation was not added to application startup.
- Verification for this task: `npm run check` and `git diff --check` passed.
  Existing HTTP tests passed 3/5. Two failed because current application routes
  already use `/health` rather than `/api/health`, and `/users` has a placeholder
  GET handler returning 200 while the test expects 404. These pre-existing route
  changes were left untouched because this task only authorizes collection setup.

### Planned document fields (not enforced or populated by this setup)

- `user`: `name`, `email`, `image`, `phone`, `area`, `bio` are strings;
  `role` is `customer`, `technician`, or `admin`. Preserve all BetterAuth-managed
  fields and its existing schema. No role defaults or backfills were applied.
- `services`: `title`, `category`, `description`, `image`, `estimatedDuration`,
  `serviceMode`, `serviceArea`, `technicianName`, `technicianEmail` are strings;
  `basePrice` is a number; `approvalStatus` is `pending`, `approved`, or `rejected`;
  `isAvailable` is boolean; `createdAt` is a Date.
- `bookings`: `serviceId`, `serviceTitle`, `serviceImage`, `category`,
  `technicianName`, `technicianEmail`, `customerName`, `customerEmail`,
  `customerPhone`, `address`, `problemDescription` are strings; `basePrice` and
  `finalAmount` are numbers; `preferredDate` is a Date; `status` is `requested`,
  `accepted`, `rejected`, `in-progress`, `completed`, or `cancelled`;
  `paymentStatus` is `unpaid` or `paid`.

## Verified reusable database configuration (2026-11-19)

- Before changing code, a fresh connection/ping and read-only metadata inspection
  confirmed the existing `fixmateDB` contains BetterAuth `user`, `session`,
  `account`, `verification`, plus `services` and `bookings`. No physical `users`
  collection exists; do not substitute `db.collection("users")` for BetterAuth.
- `index.js` loads dotenv and awaits `connectDB()` before HTTP listening.
  `connectDB()` reuses one MongoClient, selects `fixmateDB`, and verifies ping
  before preparing collection references. Repeated calls after connection return
  the existing database without reconnecting.
- `getCollections()` returns the reusable `usersCollection` (physical `user`),
  `servicesCollection` (`services`), and `bookingsCollection` (`bookings`). It
  throws before connection or after `closeDatabase()`. Shutdown clears the cached
  database and collection references and closes the client.
- Future route files can import `getCollections` from `../../config/db.js` and
  call `const { usersCollection } = getCollections()` inside an authorized request
  handler after startup. Do not call it at module scope while routes are imported
  before the database connects. No route handlers were added in this task.
- Collection handles do not create MongoDB collections. Metadata separately
  confirmed all three physical collections exist. No database, collection,
  document, schema or index was created or modified in this configuration task.
- Live checks passed: connection/ping, database name, all three handle names and
  database names, repeated connection reuse, stable collection references, and
  guarded access before connection and after close.
- The actual `index.js` started successfully, GET `/` and current GET `/health`
  returned the expected 200 JSON, and SIGTERM exited 0. Existing application
  routes, CORS, error handlers, dotenv loading and BetterAuth were preserved.
- Syntax checks passed. Existing HTTP tests still pass 3/5, with the same two
  pre-existing failures documented above (`/api/health` and `/users`). Frontend,
  dependencies, private environment files and tests were not changed.

## Services POST authentication dependency (2026-11-19)

- Current inspection found no `verifyToken` or `requireRole` implementation in
  the backend. No verified technician identity contract is available. Do not
  interpret an opaque BetterAuth session token as a JWT or trust request body
  technician identity/role fields.
- The services route previously contained an unrestricted `insertOne()` handler
  accepting frontend technician identity. That handler was removed. POST
  `/api/services` and the preserved `/services` path now return HTTP 503 with
  `{ success: false, message }` explaining that technician authentication is
  required before service creation can be enabled. This is an unavailable-feature
  response, not a completed authentication check.
- No service creation, field validation or database insertion is enabled. Future
  implementation needs verified `verifyToken`, `requireRole("technician")`, trusted
  technician name/email, Assignment 9 required-field validation, a finite positive
  numeric basePrice, and server-controlled pending/true/current Date defaults.
- No authenticated Technician test, real insert or saved pending-status check
  was possible because authentication is not ready. No test records were inserted.
  Database configuration, frontend, dependencies and other API handlers were not
  changed in this task.
- Syntax checks passed. The new HTTP regression test passed for both paths with
  no Authorization header and with an unverified Bearer token plus spoofed role
  and technician fields. All four requests returned 503 without database access.
  The full HTTP suite passed 4/6; the same pre-existing `/api/health` and `/users`
  expectations still fail. No GET, PATCH or DELETE service handlers were added.

## Services POST integration phase (2026-11-19)

- The latest user instruction explicitly defers authentication/role authorization
  and authorizes frontend integration. This supersedes the earlier blocked-write
  decision for this phase. BetterAuth itself remains unchanged.
- POST `/api/services` (and existing `/services` mount) accepts JSON and reuses
  `getCollections().servicesCollection.insertOne()`. It returns HTTP 201 with
  `{ success: true, message, data }` containing the inserted service and `_id`.
- Required nonempty strings: title, category, description, image,
  estimatedDuration, serviceMode, serviceArea, technicianName, technicianEmail.
  basePrice must be a finite positive number, not a numeric string. Category uses
  the seven Assignment 9 categories; modes are `At home`, `Workshop`, `Both`.
  Image must be an HTTP(S) URL; technicianEmail must have email form.
- Only listed fields are saved. approvalStatus is always `pending`, isAvailable
  is always true, and createdAt is a server Date. Incoming defaults/extra fields
  cannot override these values. Invalid data returns safe JSON 400; insertion
  failures use the existing safe 500 error middleware without raw error logging.
- Technician identity submitted in this temporary phase is unverified metadata,
  not trusted authorization. A later auth phase must derive it from verified
  backend identity and apply verifyToken/requireRole before enabling role rules.
- Added service tests with a MongoDB driver stub: HTTP 201, inserted fields,
  defaults, trimming, dropped extra fields, invalid data/price rejection before
  insertOne, and safe insertion failures passed. No real service records were
  inserted by these tests. The HTTP suite passed 7/9; the same pre-existing health
  and users expectations fail. `npm run check` covers the new test file.
- Frontend Add Service page and its shared ServiceForm were inspected. It currently
  has a preview-only file input and no image-upload implementation. Frontend
  changes await the missing end of the user's instruction, which was truncated
  at “Submit the Img”. No frontend files have been modified in this phase yet.

## Verified public Services GET APIs (2026-11-19)

- GET `/api/services` uses `getCollections().servicesCollection`, filters with
  `{ approvalStatus: "approved", isAvailable: true }`, sorts by createdAt descending
  and returns HTTP 200 with `{ success: true, message, data: [...] }`. No matches
  returns an empty array. Query parameters cannot override the visibility filter.
- GET `/api/services/:id` validates the string using MongoDB `ObjectId.isValid`,
  returns JSON 400 for invalid IDs, and queries by ObjectId plus the same approved
  and available filter. Missing, pending, rejected or unavailable documents return
  the same JSON 404. A visible document returns HTTP 200 with service data.
- Both handlers pass database failures to the existing error middleware. Existing
  route mounts and POST behavior were preserved except this minimal mode fix:
  canonical modes are now `Home Visit` and `Shop Drop-off`, per the user's
  Assignment 9 clarification. Legacy `At home` maps to `Home Visit`; `Workshop`
  maps to `Shop Drop-off`. `Both` is rejected with 400 because it cannot map to a
  single allowed value. Existing stored documents were not migrated or modified.
- Expanded HTTP tests passed for list filtering/sorting, empty list, public
  details, invalid IDs before database lookup, missing/non-public 404, GET database
  errors, POST insertion/defaults, both canonical modes, legacy normalization and
  rejection of `Both`. These tests use driver stubs without real database writes.
- `npm run check` and `git diff --check` passed. The complete suite passed 14/16;
  the same pre-existing `/api/health` and `/users` test expectations still fail.
- Live read-only verification connected/pinged `fixmateDB`, confirmed the existing
  services collection, and verified GET list 200 against the actual MongoDB query,
  invalid ID 400 and missing ID 404. At verification time the collection had no
  documents, so populated details/visibility cases and successful POST were
  verified with driver-stub HTTP tests, not live inserted records.
- No frontend, auth, database configuration, dependencies, collections, records,
  indexes, PATCH or DELETE handlers were changed or added in this GET phase.

## Technician form and private listing dependency (2026-11-19)

- The current user request authorizes frontend Add Service integration with the
  existing POST, while deferring new authentication/role middleware. Existing
  POST validation, pending/true/server-Date defaults, insertOne and 201 response
  were reused unchanged. Client technician name/email remain unverified metadata.
- GET /api/services/my is declared before /:id and returns safe JSON 503 with no
  data/database access until verified technician authentication exists. Neither
  query email, submitted role nor an unverified Bearer token enables private reads.
  Future implementation must derive technician identity and role from verified
  backend auth, filter ownership, include all approval statuses and sort newest.
- Public list and detail handlers remain approved+available MongoDB queries;
  list sorting is newest first and details validate ObjectId with absent/hidden
  records returning 404. New pending services do not appear publicly.
- Current src/app.js has /api/services mounted twice and only /api-prefixed API
  mounts; these pre-existing user edits were preserved. The old alias in one POST
  test was aligned with the actual /api/services endpoint, not restored in the app.
- Frontend reuses ServiceForm with real creation enabled by server-session name/
  email props on its existing role-guarded page. Named required fields, Number()
  price, image URL, exact categories/modes, JSON POST, loading/duplicate-submit
  protection, error feedback, success/reset and pending-approval message are wired.
  Image upload/provider is not implemented. Edit preview behavior is preserved.
- Backend suite passed 18/18 after adding /my no-read and POST-to-public-visibility
  regression tests. Driver fixtures simulate persistence and later approval; no
  live database writes or real admin approvals occur in these tests.
- Live read-only checks passed: public list, POST validation 400, spoofed /my 503,
  invalid detail ID 400 and absent ID 404. fixmateDB had one existing service and
  zero approved+available; the public API IDs matched the MongoDB query.
- Frontend handler fixture tests, TypeScript and scoped ESLint passed. Browser
  public desktop/mobile empty states and unauthenticated Add Service redirect
  passed without uncaught exceptions. No logged-in technician browser submission
  or real MongoDB insertion was performed; do not claim a live write was tested.
- BetterAuth, database configuration, private environment files, dependencies,
  unrelated routes, records and indexes were unchanged. Private My Services GET
  and its actual persisted frontend listing await verified auth. Stop after this
  phase and wait for the user's next instruction.

## Technician booking requests: Accept/Reject (2026-11-20)

- This later request authorizes GET `/api/bookings/technician` and PATCH
  `/api/bookings/:id/status`. It supersedes earlier empty-router notes only for
  these handlers. Customer Booking POST is still missing; do not add it implicitly.
- Read-only live MongoDB inspection confirmed `fixmateDB.bookings` exists and
  contains zero documents. There is no live booking schema or serviceId type to
  verify. No real records, auth configuration, collections or indexes changed.
- Both handlers reuse existing BetterAuth cookie-session `verifyToken` followed
  by `requireRole("technician")`. GET filters only req.user.email, ignores submitted
  ownership, includes every status and sorts createdAt/_id descending.
- PATCH accepts only `{status:"accepted"|"rejected"}`, validates ObjectId, and uses
  atomic findOneAndUpdate with `_id`, verified technicianEmail and status=requested.
  Only status/updatedAt change. Updated document is returned. A follow-up
  owner-scoped lookup distinguishes missing/unowned 404 from already-processed 409
  without disclosing another technician's booking. Repeated or concurrent actions
  cannot both change the same requested booking. Existing error handling remains.
- Added `test/bookings.test.js`: 11 tests with HTTP session fixtures and MongoDB
  driver stubs, no live writes. Full npm test passed 54/54 including existing
  service CRUD regressions. Existing syntax checks plus the new test syntax pass.
- Frontend reuses its existing cookie bridge, role guard, cards/tabs, AlertDialog
  and Sonner. Isolated actual-source browser fixtures passed 35 checks; nine live
  guest/API smoke checks passed. Full frontend lint, TypeScript and build pass.
  These are not live signed-in booking-persistence tests. Customer creation is a
  reported dependency, not implemented in this scope. Await the next instruction.

## Admin service review (2026-11-20)

- Latest request authorizes GET `/api/admin/services` and PATCH
  `/api/admin/services/:id/approval` only, via `src/routes/admin/routes.js` and the
  new `/api/admin` mount. Existing technician/public Service CRUD and Booking/
  overview routes, database configuration and auth middleware remain unchanged.
- Both endpoints use verifyToken and requireRole("admin"). GET returns every
  service state newest first (createdAt/_id descending), empty [], existing JSON
  format and private/no-store. Incoming role, email and status query are not auth.
- PATCH accepts exactly `{approvalStatus:"approved"|"rejected"}`, validates ObjectId,
  atomically filters `_id` + approvalStatus=pending, updates only approvalStatus/
  updatedAt and returns the updated record. Availability never changes. Missing
  404, reviewed 409, invalid input 400, missing/invalid auth 401, non-admin 403.
  Existing safe auth-service/DB failures and duplicate/race protection remain.
- Added `test/admin-services.test.js`: 13 new HTTP tests using auth fixtures and
  driver stubs. Full npm test passed 75/75 including earlier Service CRUD, Booking
  and overview regressions. Tests cover public/owner visibility after real route
  fixture creation and review, unavailable approval, rejection, field preservation,
  role/session denials, invalid payloads/IDs, 404/409, races, empty and safe failures.
- Frontend uses existing cookie bridge, guarded Admin page, new AdminServices live
  cards, local status filters, confirmed Approve, AlertDialog Reject and Sonner.
  Actual-source isolated browser fixture passed 43 checks; ten live production/
  guest smoke checks passed. Full frontend lint, TypeScript, production build and
  existing backend syntax plus new route/test and whitespace checks pass.
- Read-only live inspection found fixmateDB.services has 2 pending available and
  1 approved available. MongoDB/API IDs, live homepage public links and details
  200/404 visibility matched. No real service/user records or env/auth settings
  were modified. Signed-in live Admin review remains untested; persistence tests
  use safe driver fixtures only. No new collections, indexes or dependencies.


## Complete Admin Dashboard (2026-11-20)

- The latest request authorizes the full Admin backend/frontend integration.
  Extended the existing Admin router with GET /api/admin/overview, /users,
  /bookings, /payments and PATCH /users/:id/role; existing services list and
  atomic pending-only approval/rejection remain unchanged. Every endpoint uses
  existing verifyToken and requireRole("admin"), trusted BetterAuth database
  sessions/current roles, private/no-store and safe errors. No second auth system.
- Corrected usersCollection to singular physical user, preserving BetterAuth
  identity/account/session relationships. Booking test handle whitelist now
  expects user; booking handler behavior is unchanged. No new collections,
  indexes, schemas, secrets, dependencies or real records were changed.
- Overview reads eight actual MongoDB counts (active=accepted/in-progress),
  latest five submissions/bookings by createdAt/_id descending, safe projections,
  and existing payment count. Empty counts return zero. No completed-booking or
  unverified-payment amount is reported as revenue.
- Users list projects only safe profile/role/date fields. Role PATCH accepts
  exactly customer/technician, validates ObjectId, blocks self role changes,
  public admin promotion and existing-admin demotion, and atomically restricts
  current roles to customer/technician. Only role/updatedAt change.
- Admin bookings are read-only and newest first, projecting existing business
  fields. No Admin booking-status mutation or Customer creation API was added.
- Payments are read-only; no Stripe/webhook/verified producer exists. Existing
  records are projected/sorted if present; response includes verificationAvailable
  false, revenue [], and a dependency explanation. Stored status alone is never
  trusted proof, and currencies are never combined. Reading absent payments
  does not create it. Later verified revenue needs an audited payment integration.
- Profile reuses the frontend's existing BetterAuth update-user endpoint for
  name/image only; email/role stay protected. No duplicate profile API or new
  unsupported phone/area/bio schema was introduced.
- Added test/admin.test.js (13 tests). Full npm test passed 88/88 including
  existing services/booking/technician/approval regressions. Auth and MongoDB
  driver fixtures exercise all new endpoints, exact counts/latest-five/empty,
  projections, singular user, role updates/denials, mixed currency and no fake
  verification, auth/database failures and read-only behavior. Overview prepares
  cursors before launching counts to avoid unhandled rejection on sync errors.
- Frontend actual-source browser fixtures passed 68 checks, installed BetterAuth
  memory profile checks passed 10, and live guest/production/startup checks passed
  24. Actual index.js connected/pinged MongoDB on an isolated port, then stopped.
  Frontend lint/TypeScript/build (31 pages), backend syntax and whitespace pass.
- Read-only live inspection found user/services/bookings, 3 users/3 services,
  zero bookings and no payments collection. No live writes were made. Signed-in
  live Admin mutation/persistence and populated bookings/payments remain untested;
  fixture tests are not claimed as live browser workflows. See frontend AGENTS.md
  for component/bridge details and observations of independently changing services.

## Customer Dashboard Phase 1 (2026-11-20)

- Latest request requires ordered/verified phases and approval for necessary DB
  schema changes. Implemented only Phase 1 GET /api/customer/overview, via new
  src/routes/customer/routes.js mounted in src/app.js. It uses unchanged
  verifyToken + requireRole("customer"), trusted req.user.email and the existing
  bookings collection; every query filters customerEmail. No DB writes.
- Four counts: all owned bookings, requested, accepted/in-progress, completed.
  Recent five: createdAt/_id descending, projected _id/serviceTitle/preferredDate/
  status/createdAt only. Empty returns zeros/[]. Private/no-store, safe errors and
  401/403 denials remain. Caller-supplied customer identity and role are ignored.
- Added test/customer-overview.test.js (8 HTTP auth/driver fixture tests). Full
  npm test 96/96 passed including all old workflows. New tests cover ownership,
  count groups, newest five, projections/missing data, empty, auth/DB failure,
  spoofing, no writes and fresh reads after technician changes.
- Frontend Customer overview now uses live API statistics/recent rows/refresh and
  links, existing role guard/welcome/components. Actual-source browser fixture
  passed 33 checks and live guest/regression smoke passed six. Full lint,
  TypeScript after route type generation, build (32 pages), backend existing
  syntax plus new route/test checks and whitespace checks pass.
- Read-only metadata: fixmateDB.bookings exists with zero documents, only _id
  index, no persisted serviceId schema. Topology supports transactions. Stripe
  dependency/routes/configuration are absent. No records/indexes/collections,
  env values, auth configuration or dependencies changed.
- Stop before Phase 2 pending explicit approval of unique partial booking index
  (customerEmail/serviceId for requested/accepted/in-progress) plus transaction
  coordination with existing service deletion. Do not use check-then-insert as
  concurrent protection. Latest requested finalAmount default is null, not the
  historical basePrice default. Creation/list/cancel, remaining Technician
  transitions and Stripe/payment work are not implemented by this phase.
  Existing shared Profile supports name/image only. See frontend AGENTS.md for
  remaining prerequisites; report partial completion and await authorization.


## Service booking authentication and creation (2026-11-20)

- Latest request authorizes the Service Details login/form integration and secure
  Customer POST /api/bookings, superseding earlier missing-POST/Phase 2 notes.
  Existing GET /my, cancel, Technician and Admin behavior is preserved.
- Root redirect fault was the frontend's unconditional /sign-in booking link;
  login always used /. BetterAuth configuration/verifyToken/requireRole are
  unchanged. Frontend now waits for session loading, opens a Customer form,
  distinguishes other roles and safely returns guests to /services/:id after login.
- POST uses verifyToken + requireRole("customer"), strict five-field validation,
  native ObjectId and non-past calendar date checks. Identity comes from req.user;
  service snapshot/price/provider come from approved+available MongoDB data.
  Defaults requested/unpaid/finalAmount:null, server dates, canonical String
  serviceId and BSON preferredDate. No submitted identity/role/amount is trusted.
- User approved setup-booking-index.js through the tool approval: unique partial
  bookings index {customerEmail:1,serviceId:1} for requested/accepted/in-progress,
  name unique_active_customer_service. Run node scripts/setup-booking-index.js
  from this backend directory when deploying another database. No startup index
  writes. POST returns safe 503 if the exact required index is missing and 409
  for duplicate active bookings. No new collection or auth system introduced.
- db.js exports withDatabaseTransaction using the existing client/session.
  Creation increments internal services.bookingRevision then inserts booking in
  one transaction. Existing service deletion now checks references/deletes within
  a transaction; conflicting creation/deletion or availability changes retry and
  preserve references. Prior ownership/history/status rules remain. Duplicate or
  failed inserts roll back the service counter. No actual records backfilled.
- New test/booking-create.test.js adds 12 HTTP driver/session fixture tests;
  service reference tests now assert session use. Full npm test passed 119/119:
  snapshots/defaults, own/assigned lists, validation/auth/roles/errors, index gate,
  concurrent/processed duplicates, cancellation/rebooking and rollback. All prior
  Customer/Technician/Admin/Services regressions pass. New test/script syntax and
  existing npm run check/whitespace checks passed.
- Installed real BetterAuth memory-adapter/signed-cookie fixture passed 15 checks;
  actual-source frontend browser fixture passed 33 plus three real guest browser
  checks (36 total); live guest/API smoke checks passed 12. No successful live
  auth or booking write was made by these tests. See frontend AGENTS.md for details.
- Read-only MongoDB inspection initially found zero bookings. Setup created only
  the approved index. Later an independently created booking was observed with
  correct field types/defaults, matching snapshot/Customer ownership and service
  counter=1. That record's stored provider currently has Admin role, so it cannot
  use Technician APIs without an authorized role change. No role was changed.
  Signed-in live Technician display and tool-driven live creation remain untested.
- No dependencies, environment/auth configuration, Admin mutations, payments or
  unrelated features were added. Preserve earlier uncommitted Customer work.
