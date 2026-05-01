import { pgSchema } from "drizzle-orm/pg-core";

/**
 * The single Postgres schema that holds every resupply table.
 *
 * The PennPaps fitter (the original CPAP fitter product) lives in `public.*`. Putting
 * resupply tables under their own schema keeps the two products from
 * stepping on each other's table names (e.g. both have a `patients`-shaped
 * concept) and lets us grant DB roles per-product later.
 */
export const resupplySchema = pgSchema("resupply");
