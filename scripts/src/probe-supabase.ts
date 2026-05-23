import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
const c = getSupabaseServiceRoleClient();
const r1 = await c
  .schema("resupply")
  .from("shop_customers")
  .select("customer_id")
  .limit(1);
console.log(
  "resupply:",
  JSON.stringify({ status: r1.status, error: r1.error, n: r1.data?.length }),
);
const r2 = await c
  .schema("resupply_auth")
  .from("users")
  .select("id,email_lower,role")
  .limit(3);
console.log(
  "resupply_auth:",
  JSON.stringify({ status: r2.status, error: r2.error, data: r2.data }),
);
