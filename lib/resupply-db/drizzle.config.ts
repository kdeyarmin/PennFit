import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run drizzle-kit against the resupply schema.");
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  schemaFilter: ["resupply"],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
});
