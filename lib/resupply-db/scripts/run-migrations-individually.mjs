// Diagnostic: run each migration in its own transaction, catch errors,
// continue to find ALL the bugs.  NOT for production use.

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const journal = JSON.parse(
  fs.readFileSync(
    "/home/user/PennFit/lib/resupply-db/migrations/meta/_journal.json",
    "utf8",
  ),
);
const migrationsDir = "/home/user/PennFit/lib/resupply-db/migrations";

const pool = new pg.Pool({
  connectionString: "postgresql://pennfit:pennfit@localhost:5432/pennfit_test",
});
const client = await pool.connect();
const failures = [];
try {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "auth"`);
  await client.query(`CREATE SCHEMA IF NOT EXISTS "migrations"`);
  for (const entry of journal.entries) {
    const filePath = path.join(migrationsDir, entry.tag + ".sql");
    const sql = fs.readFileSync(filePath, "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      failures.push({ idx: entry.idx, tag: entry.tag, message: err.message });
    }
  }
} finally {
  client.release();
  await pool.end();
}
console.log(`\nFailures: ${failures.length}`);
for (const f of failures) {
  console.log(`  [${f.idx}] ${f.tag}: ${f.message}`);
}
