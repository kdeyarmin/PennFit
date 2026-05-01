import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run drizzle-kit against the resupply schema.");
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["resupply"],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // Migration history lives in `drizzle.resupply_migrations` so it
  // never collides with the PennPaps fitter's `public.*` tables. The `drizzle`
  // schema is created on demand by `scripts/migrate.mjs` since
  // drizzle-orm's migrator does not auto-create it. If you ever
  // change these names, also update `scripts/migrate.mjs`.
  migrations: {
    schema: "drizzle",
    table: "resupply_migrations",
  },
  strict: true,
});
