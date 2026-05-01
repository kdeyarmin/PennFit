import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  out: "./drizzle",
  dialect: "postgresql",
  // The storefront tables live in the default `public` schema. The
  // resupply tables share the same physical database but live in
  // their own `resupply` schema, so filter to `public` to keep
  // generated migrations from accidentally touching resupply tables
  // (whose history is owned by `lib/resupply-db`).
  schemaFilter: ["public"],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // Migration history lives in `drizzle.storefront_migrations` so it
  // never collides with `drizzle.resupply_migrations` (owned by
  // `lib/resupply-db`) — both libraries point at the same physical
  // database. The `drizzle` schema is created on demand by
  // `scripts/migrate.mjs` since drizzle-orm's migrator does not
  // auto-create it. If you ever change these names, also update
  // `scripts/migrate.mjs`.
  migrations: {
    schema: "drizzle",
    table: "storefront_migrations",
  },
  strict: true,
});
