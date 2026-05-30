import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { buildResupplyDueItems } from "./resupply-due-items";

const EPISODE_ID = "00000000-0000-4000-8000-000000000001";
const RX_ID = "00000000-0000-4000-8000-000000000002";

beforeEach(() => supabaseMock.reset());

function stageEpisodeAndRx(itemSku: string): void {
  stageSupabaseResponse("episodes", "select", {
    data: { id: EPISODE_ID, prescription_id: RX_ID },
    error: null,
  });
  stageSupabaseResponse("prescriptions", "select", {
    data: { id: RX_ID, item_sku: itemSku },
    error: null,
  });
}

describe("buildResupplyDueItems", () => {
  it("resolves the item name + category from the HCPCS catalog", async () => {
    stageEpisodeAndRx("CUSHION-NASAL-MED");
    stageSupabaseResponse("sku_hcpcs_map", "select", {
      data: [{ sku_prefix: "CUSHION", hcpcs_code: "A7032" }],
      error: null,
    });
    stageSupabaseResponse("hcpcs_codes", "select", {
      data: {
        category: "cushion",
        short_description: "Nasal mask cushion (replacement)",
      },
      error: null,
    });

    const items = await buildResupplyDueItems(
      getSupabaseServiceRoleClient(),
      EPISODE_ID,
    );

    expect(items).toEqual([
      { name: "Nasal mask cushion", category: "cushion", quantity: 1 },
    ]);
  });

  it("falls back to a humanized SKU + 'other' when the SKU is unmapped", async () => {
    stageEpisodeAndRx("WIPES-ALCOHOL-PK");
    stageSupabaseResponse("sku_hcpcs_map", "select", {
      data: [{ sku_prefix: "CUSHION", hcpcs_code: "A7032" }],
      error: null,
    });

    const items = await buildResupplyDueItems(
      getSupabaseServiceRoleClient(),
      EPISODE_ID,
    );

    expect(items).toEqual([
      { name: "Wipes alcohol pk", category: "other", quantity: 1 },
    ]);
  });

  it("picks the longest matching SKU prefix", async () => {
    stageEpisodeAndRx("MASK-FULL-LG");
    stageSupabaseResponse("sku_hcpcs_map", "select", {
      data: [
        { sku_prefix: "MASK", hcpcs_code: "A7034" },
        { sku_prefix: "MASK-FULL", hcpcs_code: "A7030" },
      ],
      error: null,
    });
    stageSupabaseResponse("hcpcs_codes", "select", {
      data: { category: "mask", short_description: "Full face mask interface" },
      error: null,
    });

    const items = await buildResupplyDueItems(
      getSupabaseServiceRoleClient(),
      EPISODE_ID,
    );

    expect(items[0]!.name).toBe("Full face mask interface");
    expect(items[0]!.category).toBe("mask");
  });

  it("returns [] when the episode has no prescription", async () => {
    stageSupabaseResponse("episodes", "select", {
      data: { id: EPISODE_ID, prescription_id: null },
      error: null,
    });

    const items = await buildResupplyDueItems(
      getSupabaseServiceRoleClient(),
      EPISODE_ID,
    );

    expect(items).toEqual([]);
  });
});
