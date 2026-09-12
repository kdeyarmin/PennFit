// Run in the existing local/CI migration stack, or opt in explicitly with
// PACKET_TEST_DATABASE_URL. Every row belongs to a fresh test organization.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function isLocalTestDatabase(value: string): boolean {
  const url = new URL(value);
  return (
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    /(?:^|_)(?:ci|test|e2e|review)(?:_|$)/.test(url.pathname.slice(1))
  );
}
const configuredUrl = process.env.PACKET_TEST_DATABASE_URL;
if (configuredUrl && !isLocalTestDatabase(configuredUrl)) {
  throw new Error(
    "Packet integration tests require a loopback test/CI/review database",
  );
}
const databaseUrl =
  configuredUrl ??
  (process.env.DATABASE_URL && isLocalTestDatabase(process.env.DATABASE_URL)
    ? process.env.DATABASE_URL
    : undefined);
const orgId = randomUUID();
const functionName =
  "resupply.finalize_patient_packet(uuid,uuid,integer,text[],jsonb)";
const signature = {
  signer_name: "Fixture Signer",
  signer_relationship: "self",
};

describe.skipIf(!databaseUrl)(
  "atomic patient packet finalization in PostgreSQL",
  () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({
        connectionString: databaseUrl,
        max: 8,
        application_name: `packet-test-${orgId}`,
      });
      await pool.query(
        readFileSync(
          new URL(
            "../migrations/0545_finalize_patient_packet.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      // The migration-only CI database creates bare Supabase roles. Give this
      // local fixture the table access and RLS bypass managed service_role has,
      // without broadening the production migration or its RPC EXECUTE grants.
      await pool.query(`
        ALTER ROLE service_role BYPASSRLS;
        GRANT USAGE ON SCHEMA resupply TO service_role;
        GRANT SELECT, INSERT, UPDATE ON resupply.patient_packets TO service_role;
        GRANT SELECT, INSERT, UPDATE, DELETE ON resupply.patient_packet_documents TO service_role;
        GRANT SELECT, INSERT ON resupply.patient_packet_signatures TO service_role;
      `);
      await pool.query(
        "INSERT INTO resupply.organizations (id, slug, name) VALUES ($1, $2, 'Packet test fixture')",
        [orgId, `packet-test-${orgId}`],
      );
    });
    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        "DELETE FROM resupply.patient_packets WHERE org_id = $1",
        [orgId],
      );
      await pool.query("DELETE FROM resupply.organizations WHERE id = $1", [
        orgId,
      ]);
      await pool.end();
    });

    async function packet(
      options: { version?: number; expiresAt?: string } = {},
    ) {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO resupply.patient_packets (id, org_id, title, recipient_name, status, link_version, expires_at) VALUES ($1, $2, 'Fixture documents', 'Fixture Signer', 'sent', $3, $4)",
        [
          id,
          orgId,
          options.version ?? 1,
          options.expiresAt ?? "2099-01-01T00:00:00Z",
        ],
      );
      await pool.query(
        "INSERT INTO resupply.patient_packet_documents (org_id, packet_id, document_key, title, content_version) VALUES ($1, $2, 'welcome', 'Fixture document', '1')",
        [orgId, id],
      );
      return id;
    }

    async function finalize(
      id: string,
      options: { org?: string; version?: number; keys?: string[] } = {},
    ) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE service_role");
        const result = await client.query(
          "SELECT resupply.finalize_patient_packet($1, $2, $3, $4, $5) AS result",
          [
            options.org ?? orgId,
            id,
            options.version ?? 1,
            options.keys ?? ["welcome"],
            signature,
          ],
        );
        await client.query("COMMIT");
        return result.rows[0].result as {
          status: string;
          completed_at?: string;
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    async function state(id: string) {
      return (
        await pool.query(
          `SELECT p.status, p.link_version,
      (SELECT count(*)::int FROM resupply.patient_packet_signatures s WHERE s.packet_id = p.id) AS signatures,
      (SELECT bool_and(d.acknowledged) FROM resupply.patient_packet_documents d WHERE d.packet_id = p.id) AS acknowledged
      FROM resupply.patient_packets p WHERE p.id = $1`,
          [id],
        )
      ).rows[0];
    }

    const revisedDocument = {
      document_key: "welcome",
      title: "Revised fixture document",
      content_version: "2",
      content_sections: [{ paragraphs: ["Revised fixture content"] }],
      sort_order: 0,
      requires_signature: true,
    };
    async function edit(id: string, client: Pool | PoolClient = pool) {
      return (
        await client.query(
          "SELECT resupply.update_patient_packet($1,$2,1,NULL,$3,$4) AS result",
          [orgId, id, JSON.stringify([revisedDocument]), {}],
        )
      ).rows[0].result;
    }
    async function waitForPacketLock() {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const waiting = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
          [`packet-test-${orgId}`],
        );
        if (waiting.rowCount) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        "Expected packet operation to wait on the concurrent transaction",
      );
    }
    function observe<T>(pending: Promise<T>): Promise<T> {
      // Concurrent work can reject before the lock assertion reaches its await.
      // Attach a handler now; awaiting the original promise still fails the test.
      void pending.catch(() => undefined);
      return pending;
    }
    async function releaseTransaction(client: PoolClient) {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }

    it("creates envelope and snapshots together and rolls both back for invalid documents", async () => {
      const envelope = {
        title: "Atomic fixture",
        recipient_name: "Fixture Signer",
        sent_at: "2026-09-11T12:00:00Z",
        expires_at: "2099-01-01T00:00:00Z",
      };
      const invalidDocument = { ...revisedDocument, title: null };
      const countBefore = (
        await pool.query(
          "SELECT count(*)::int AS count FROM resupply.patient_packets WHERE org_id=$1",
          [orgId],
        )
      ).rows[0].count;
      for (const documents of [null, {}, [], [invalidDocument]]) {
        await expect(
          pool.query("SELECT resupply.create_patient_packet($1,$2,$3)", [
            orgId,
            envelope,
            documents === null ? null : JSON.stringify(documents),
          ]),
        ).rejects.toThrow();
      }
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM resupply.patient_packets WHERE org_id=$1",
            [orgId],
          )
        ).rows[0].count,
      ).toBe(countBefore);
      const created = (
        await pool.query(
          "SELECT resupply.create_patient_packet($1,$2,$3) AS result",
          [orgId, envelope, JSON.stringify([revisedDocument])],
        )
      ).rows[0].result;
      expect(await state(created.id)).toEqual({
        status: "sent",
        link_version: 1,
        signatures: 0,
        acknowledged: false,
      });
    });

    it("does not complete an old empty packet", async () => {
      const id = await packet();
      await pool.query(
        "DELETE FROM resupply.patient_packet_documents WHERE packet_id=$1",
        [id],
      );
      expect((await finalize(id, { keys: [] })).status).toBe(
        "documents_required",
      );
      expect((await state(id)).signatures).toBe(0);
      expect((await state(id)).status).toBe("sent");
    });

    it("invalidates the old signing version when a same-key edit commits first", async () => {
      const id = await packet();
      const editor = await pool.connect();
      let signing: ReturnType<typeof finalize> | undefined;
      try {
        await editor.query("BEGIN");
        await editor.query("SET LOCAL ROLE service_role");
        expect((await edit(id, editor)).status).toBe("updated");
        signing = observe(finalize(id));
        await waitForPacketLock();
        await editor.query("COMMIT");
        expect((await signing).status).toBe("invalid");
        expect(await state(id)).toEqual({
          status: "sent",
          link_version: 2,
          signatures: 0,
          acknowledged: false,
        });
        const doc = (
          await pool.query(
            "SELECT title, content_sections FROM resupply.patient_packet_documents WHERE packet_id=$1",
            [id],
          )
        ).rows[0];
        expect(doc).toEqual({
          title: revisedDocument.title,
          content_sections: revisedDocument.content_sections,
        });
        expect((await finalize(id, { version: 2 })).status).toBe("completed");
      } finally {
        await releaseTransaction(editor);
        await signing?.catch(() => undefined);
      }
    });

    it("leaves signed content untouched when signing commits before an edit", async () => {
      const id = await packet();
      const signer = await pool.connect();
      let editing: ReturnType<typeof edit> | undefined;
      try {
        await signer.query("BEGIN");
        await signer.query("SET LOCAL ROLE service_role");
        await signer.query(
          "SELECT resupply.finalize_patient_packet($1,$2,1,$3,$4)",
          [orgId, id, ["welcome"], signature],
        );
        editing = observe(edit(id));
        await waitForPacketLock();
        await signer.query("COMMIT");
        expect((await editing).status).toBe("packet_closed");
        expect(await state(id)).toEqual({
          status: "completed",
          link_version: 1,
          signatures: 1,
          acknowledged: true,
        });
        expect(
          (
            await pool.query(
              "SELECT title FROM resupply.patient_packet_documents WHERE packet_id=$1",
              [id],
            )
          ).rows[0].title,
        ).toBe("Fixture document");
      } finally {
        await releaseTransaction(signer);
        await editing?.catch(() => undefined);
      }
    });

    it("serializes concurrent submits and returns the existing completion on retry", async () => {
      const id = await packet();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => finalize(id)),
      );
      expect(results.filter((r) => r.status === "completed")).toHaveLength(1);
      expect(
        results.filter((r) => r.status === "already_completed"),
      ).toHaveLength(5);
      expect(new Set(results.map((r) => r.completed_at)).size).toBe(1);
      expect(await state(id)).toEqual({
        status: "completed",
        link_version: 1,
        signatures: 1,
        acknowledged: true,
      });
    });

    it("rolls back signature and acknowledgements if the final packet update fails, then retries", async () => {
      const id = await packet();
      const hook = `packet_test_failure_${id.replaceAll("-", "")}`;
      await pool.query(`CREATE FUNCTION resupply.${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture finalization failure'; END $$;
      CREATE TRIGGER ${hook} BEFORE UPDATE ON resupply.patient_packets FOR EACH ROW
      WHEN (NEW.id = '${id}'::uuid AND NEW.status = 'completed') EXECUTE FUNCTION resupply.${hook}();`);
      try {
        await expect(finalize(id)).rejects.toThrow(
          "fixture finalization failure",
        );
        expect(await state(id)).toEqual({
          status: "sent",
          link_version: 1,
          signatures: 0,
          acknowledged: false,
        });
      } finally {
        await pool.query(
          `DROP TRIGGER ${hook} ON resupply.patient_packets; DROP FUNCTION resupply.${hook}();`,
        );
      }
      expect((await finalize(id)).status).toBe("completed");
      expect(await state(id)).toEqual({
        status: "completed",
        link_version: 1,
        signatures: 1,
        acknowledged: true,
      });
    });

    it("rechecks tenant, version, expiration and document set before any signature write", async () => {
      const id = await packet({ version: 2 });
      expect((await finalize(id)).status).toBe("invalid");
      expect(
        (await finalize(id, { version: 2, org: randomUUID() })).status,
      ).toBe("not_found");
      expect((await finalize(id, { version: 2, keys: [] })).status).toBe(
        "concurrent_modification",
      );
      expect(await state(id)).toEqual({
        status: "sent",
        link_version: 2,
        signatures: 0,
        acknowledged: false,
      });
      const expired = await packet({ expiresAt: "2000-01-01T00:00:00Z" });
      expect((await finalize(expired)).status).toBe("expired");
      expect((await state(expired)).signatures).toBe(0);
    });

    it("detects a document removed by an edit already in progress", async () => {
      const id = await packet();
      const editor = await pool.connect();
      let signing: ReturnType<typeof finalize> | undefined;
      try {
        await editor.query("BEGIN");
        await editor.query(
          "DELETE FROM resupply.patient_packet_documents WHERE packet_id = $1",
          [id],
        );
        signing = observe(finalize(id));
        // Synchronize on PostgreSQL's actual lock wait rather than guessing
        // how long the signing connection needs to reach the held document.
        const deadline = Date.now() + 3000;
        let blocked = false;
        while (!blocked && Date.now() < deadline) {
          const waiting = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE 'SELECT resupply.finalize_patient_packet%'",
            [`packet-test-${orgId}`],
          );
          blocked = waiting.rowCount !== 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
        await editor.query("COMMIT");
        expect((await signing).status).toBe("documents_required");
        expect((await state(id)).signatures).toBe(0);
      } finally {
        await releaseTransaction(editor);
        await signing?.catch(() => undefined);
      }
    });
    it("does not replace a signature left by the previous non-atomic writer", async () => {
      const id = await packet();
      await pool.query(
        "INSERT INTO resupply.patient_packet_signatures (org_id, packet_id, signer_name) VALUES ($1, $2, 'Original fixture signer')",
        [orgId, id],
      );
      expect((await finalize(id)).status).toBe("concurrent_modification");
      expect(await state(id)).toEqual({
        status: "sent",
        link_version: 1,
        signatures: 1,
        acknowledged: false,
      });
    });

    it("restores existing documents when a replacement snapshot fails", async () => {
      const id = await packet();
      const invalid = {
        ...revisedDocument,
        document_key: "replacement",
        title: null,
      };
      await expect(
        pool.query("SELECT resupply.update_patient_packet($1,$2,1,$3,$4,$5)", [
          orgId,
          id,
          ["replacement"],
          JSON.stringify([invalid]),
          { title: "Edited fixture" },
        ]),
      ).rejects.toThrow();
      expect(await state(id)).toEqual({
        status: "sent",
        link_version: 1,
        signatures: 0,
        acknowledged: false,
      });
      expect(
        (
          await pool.query(
            "SELECT document_key, title FROM resupply.patient_packet_documents WHERE packet_id=$1",
            [id],
          )
        ).rows,
      ).toEqual([{ document_key: "welcome", title: "Fixture document" }]);
    });

    it.each([
      functionName,
      "resupply.update_patient_packet(uuid,uuid,integer,text[],jsonb,jsonb)",
      "resupply.create_patient_packet(uuid,jsonb,jsonb)",
    ])("restricts %s to service-role invoker privileges", async (name) => {
      const result = await pool.query(
        "SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon, has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated, has_function_privilege('service_role', $1, 'EXECUTE') AS service_role, (SELECT prosecdef FROM pg_proc WHERE oid = $1::regprocedure) AS definer",
        [name],
      );
      expect(result.rows[0]).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
        definer: false,
      });
    });
  },
);
