import type { OrgScopedClient } from "@workspace/resupply-db";

/** Apply the same current delivery gate to the file handed to PacWare. */
export async function filterDeliveryReadyEpisodes<T extends { id: string }>(
  db: OrgScopedClient,
  orgId: string,
  episodes: T[],
): Promise<{ rows: T[]; withheld: number }> {
  if (!episodes.length) return { rows: [], withheld: 0 };
  const { data, error } = await db
    .raw()
    .schema("resupply")
    .rpc("csr_pricing_held_episode_ids", {
      p_org_id: orgId,
      p_episode_ids: episodes.map((row) => row.id),
    });
  if (error) throw error;
  if (!Array.isArray(data) || data.some((id) => typeof id !== "string")) {
    throw new Error(
      "Delivery review is unavailable. Retry before exporting orders.",
    );
  }
  const held = new Set(data);
  const rows = episodes.filter((row) => !held.has(row.id));
  return { rows, withheld: episodes.length - rows.length };
}
