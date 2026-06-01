// Mint a Supabase-style `service_role` JWT (HS256) for test / CI use.
//
// Supabase's service-role key is a JWT with a `role: service_role`
// claim, signed with the project's JWT secret; PostgREST verifies it
// against PGRST_JWT_SECRET and `SET ROLE service_role` for the request.
// For a standalone PostgREST we mint the equivalent here with Node's
// built-in crypto (no jsonwebtoken dependency).
//
// Usage:
//   node scripts/ci/gen-service-role-jwt.mjs <jwt-secret>
//   PGRST_JWT_SECRET=... node scripts/ci/gen-service-role-jwt.mjs
//
// Prints the JWT to stdout (no trailing newline beyond console.log).
// TEST/CI ONLY — never mint or accept a service_role token this way in
// production; the real key comes from the Supabase dashboard.

import crypto from "node:crypto";

const secret = process.argv[2] || process.env.PGRST_JWT_SECRET || "";
if (secret.length < 32) {
  process.stderr.write(
    "[gen-service-role-jwt] a JWT secret of >=32 chars is required " +
      "(arg 1 or PGRST_JWT_SECRET)\n",
  );
  process.exit(2);
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64url({ alg: "HS256", typ: "JWT" });
const payload = b64url({
  role: "service_role",
  iss: "pennfit-test-postgrest",
  iat: now,
  exp: now + 8 * 3600,
});
const data = `${header}.${payload}`;
const sig = crypto
  .createHmac("sha256", secret)
  .update(data)
  .digest("base64url");

process.stdout.write(`${data}.${sig}`);
