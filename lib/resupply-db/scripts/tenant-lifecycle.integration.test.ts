import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSupabaseServiceRoleClient } from "../src/supabase-client";
import { createTenantLifecycleHandler } from "../../../artifacts/resupply-api/src/lib/tenant-lifecycle";
import { tenantLifecycleDomain as domain } from "../../../artifacts/resupply-api/src/lib/tenant-lifecycle-protocol";

const dbUrl = process.env.DATABASE_URL;
// These tests intentionally leave immutable synthetic receipts in a disposable
// CI database. Never accept a hosted database or a developer's named database.
if (
  dbUrl &&
  (!["localhost", "127.0.0.1"].includes(new URL(dbUrl).hostname) ||
    new URL(dbUrl).pathname !== "/resupply_ci")
)
  throw Error(
    "Tenant lifecycle integration requires local disposable resupply_ci",
  );
const httpReady =
  !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
if (process.env.BREATHE_LIFECYCLE_HTTP_REQUIRED === "true" && !httpReady)
  throw Error("Required lifecycle HTTP fixture is unconfigured");

describe.skipIf(!dbUrl)(
  "tenant lifecycle actual PostgreSQL authority and receipts",
  () => {
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({
        connectionString: dbUrl,
        max: 6,
        connectionTimeoutMillis: 3000,
        statement_timeout: 6000,
      });
    });
    afterAll(async () => {
      await pool.end();
    });

    async function fixture(status = "active") {
      const nativeId = `lifecycle_${randomUUID()}`;
      const hubId = randomUUID();
      const sessionId = randomUUID();
      const targetId = randomUUID();
      await pool.query(
        "INSERT INTO resupply_auth.users(id,email_lower,role,status,email_verified_at) VALUES($1,$2,'admin','active',clock_timestamp())",
        [nativeId, `${nativeId}@example.test`],
      );
      await pool.query(
        "INSERT INTO resupply.platform_admins(auth_user_id) VALUES($1)",
        [nativeId],
      );
      await pool.query(
        "INSERT INTO resupply.organizations(id,slug,name,status) VALUES($1,$2,$3,$4)",
        [
          targetId,
          `lifecycle-${randomUUID()}`,
          "Synthetic lifecycle tenant",
          status,
        ],
      );
      const startedAt = Date.now();
      const actor = {
        user_id: hubId,
        native_user_id: nativeId,
        role: "platform_admin",
        method: "sms",
        session_id: sessionId,
        session_started_at: new Date(startedAt).toISOString(),
        assurance_expires_at: new Date(startedAt + 28800000).toISOString(),
      };
      const call = async (
        operation: Record<string, unknown>,
        override: Record<string, unknown> = {},
        client: Pool | PoolClient = pool,
      ) => {
        const result = await client.query(
          "SELECT resupply.tenant_lifecycle_command($1::jsonb,$2::jsonb) AS result",
          [
            JSON.stringify({ ...actor, ...override, operation }),
            JSON.stringify(operation),
          ],
        );
        return result.rows[0].result;
      };
      const context = () => call({ domain, operation: "context", targetId });
      const preview = async (suspended = true) => {
        const source = await context();
        return call({
          domain,
          operation: "preview",
          requestId: randomUUID(),
          targetId,
          action: "organizations.setSuspension",
          parameters: { suspended },
          expectedRevision: source.target.revision,
          reason: "Reviewed tenant lifecycle change",
        });
      };
      return {
        nativeId,
        hubId,
        sessionId,
        targetId,
        actor,
        call,
        context,
        preview,
      };
    }
    const apply = (preview: { commandId: string; previewDigest: string }) => ({
      domain,
      operation: "apply",
      commandId: preview.commandId,
      expectedDigest: preview.previewDigest,
    });
    async function status(targetId: string) {
      return (
        await pool.query(
          "SELECT status FROM resupply.organizations WHERE id=$1",
          [targetId],
        )
      ).rows[0].status;
    }
    async function blocked(client: PoolClient) {
      const pid = (await client.query("SELECT pg_backend_pid() AS id")).rows[0]
        .id;
      return async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            (
              await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
                [pid],
              )
            ).rowCount
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw Error("Expected blocked native transaction");
      };
    }

    it("previews without writes and applies once with immutable exact receipt", async () => {
      const f = await fixture();
      const preview = await f.preview();
      expect(preview.canApplyThisSession).toBe(true);
      expect(await status(f.targetId)).toBe("active");
      const first = await f.call(apply(preview));
      expect(first.result).toMatchObject({
        commandId: preview.commandId,
        requestId: preview.requestId,
        beforeStatus: "active",
        afterStatus: "suspended",
      });
      expect(first.canApplyThisSession).toBe(false);
      expect(await status(f.targetId)).toBe("suspended");
      expect(await f.call(apply(preview))).toEqual(first);
      await expect(
        pool.query(
          "UPDATE resupply_private.tenant_lifecycle_intents SET reason='changed reason' WHERE command_id=$1",
          [preview.commandId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        pool.query(
          "DELETE FROM resupply_private.tenant_lifecycle_intents WHERE command_id=$1",
          [preview.commandId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    });
    it("replays the same request exactly and refuses request-id substitution", async () => {
      const f = await fixture();
      const c = await f.context();
      const op = {
        domain,
        operation: "preview",
        requestId: randomUUID(),
        targetId: f.targetId,
        action: "organizations.setSuspension",
        parameters: { suspended: true },
        expectedRevision: c.target.revision,
        reason: "Reviewed tenant lifecycle change",
      };
      const p = await f.call(op);
      expect(await f.call(op)).toEqual(p);
      await expect(
        f.call({ ...op, reason: "A different lifecycle reason" }),
      ).rejects.toMatchObject({ code: "40001" });
      await expect(
        f.call(op, { session_id: randomUUID() }),
      ).rejects.toMatchObject({ code: "40001" });
    });
    it("recovers a lost preview and completed receipt across current same-actor sessions without an apply grant", async () => {
      const f = await fixture();
      const p = await f.preview();
      const fresh = { session_id: randomUUID() };
      const recovered = await f.call(
        { domain, operation: "resume", requestId: p.requestId },
        fresh,
      );
      expect(recovered.canApplyThisSession).toBe(false);
      await expect(f.call(apply(p), fresh)).rejects.toMatchObject({
        code: "42501",
      });
      const done = await f.call(apply(p));
      expect(
        (
          await f.call(
            { domain, operation: "resume", requestId: p.requestId },
            fresh,
          )
        ).result,
      ).toEqual(done.result);
      expect(
        (
          await f.call(
            { domain, operation: "context", targetId: f.targetId },
            fresh,
          )
        ).requests[0].result,
      ).toEqual(done.result);
      await expect(
        f.call(
          { domain, operation: "resume", requestId: p.requestId },
          { user_id: randomUUID() },
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
    it("compares the complete organization row including fields absent from the safe projection", async () => {
      const f = await fixture();
      const p = await f.preview();
      await pool.query(
        "UPDATE resupply.organizations SET from_name='Changed privately after review' WHERE id=$1",
        [f.targetId],
      );
      expect((await f.context()).target.revision).not.toBe(p.before.revision);
      await expect(f.call(apply(p))).rejects.toMatchObject({ code: "40001" });
      expect(await status(f.targetId)).toBe("active");
    });
    it("protects the actual seed identity and treats archived Hub targets as read-only", async () => {
      const f = await fixture("archived");
      expect((await f.context()).target.status).toBe("archived");
      await expect(f.preview(false)).rejects.toMatchObject({ code: "22023" });
      const seed = (
        await pool.query(
          "SELECT id FROM resupply.organizations WHERE slug='penn-home-medical'",
        )
      ).rows[0].id;
      const context = await f.call({
        domain,
        operation: "context",
        targetId: seed,
      });
      expect(context.target.seedProtected).toBe(true);
      await expect(
        f.call({
          domain,
          operation: "preview",
          requestId: randomUUID(),
          targetId: seed,
          action: "organizations.setSuspension",
          parameters: { suspended: true },
          expectedRevision: context.target.revision,
          reason: "Cannot suspend the seed tenant",
        }),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        pool.query(
          "SELECT resupply.set_tenant_lifecycle_status($1,$2,'suspended')",
          [f.nativeId, seed],
        ),
      ).rejects.toMatchObject({ code: "22023" });
    });
    it("preserves existing native reactivation of archived tenants through the shared writer", async () => {
      const f = await fixture("archived");
      const result = await pool.query(
        "SELECT resupply.set_tenant_lifecycle_status($1,$2,'active') AS result",
        [f.nativeId, f.targetId],
      );
      expect(result.rows[0].result).toMatchObject({
        id: f.targetId,
        status: "active",
      });
      expect(Object.keys(result.rows[0].result).sort()).toEqual(
        [
          "id",
          "slug",
          "name",
          "storefront_name",
          "status",
          "custom_domain",
          "custom_domain_status",
          "created_at",
        ].sort(),
      );
    });
    it.each(["membership", "role", "status", "verified"])(
      "denies revoked native %s even on a completed replay",
      async (kind) => {
        const f = await fixture();
        const p = await f.preview();
        await f.call(apply(p));
        if (kind === "membership")
          await pool.query(
            "DELETE FROM resupply.platform_admins WHERE auth_user_id=$1",
            [f.nativeId],
          );
        else if (kind === "role")
          await pool.query(
            "UPDATE resupply_auth.users SET role='agent' WHERE id=$1",
            [f.nativeId],
          );
        else if (kind === "status")
          await pool.query(
            "UPDATE resupply_auth.users SET status='revoked' WHERE id=$1",
            [f.nativeId],
          );
        else
          await pool.query(
            "UPDATE resupply_auth.users SET email_verified_at=NULL WHERE id=$1",
            [f.nativeId],
          );
        await expect(f.call(apply(p))).rejects.toMatchObject({ code: "42501" });
        await expect(f.context()).rejects.toMatchObject({ code: "42501" });
      },
    );
    it("rejects stale/misbound/extra actor fields and private direct execution", async () => {
      const f = await fixture();
      const op = { domain, operation: "context", targetId: f.targetId };
      await expect(f.call(op, { extra: true })).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        f.call(op, {
          assurance_expires_at: new Date(Date.now() - 1).toISOString(),
        }),
      ).rejects.toMatchObject({ code: "28000" });
      await expect(
        pool.query("SELECT resupply.tenant_lifecycle_command($1,$2)", [
          JSON.stringify({
            ...f.actor,
            operation: { ...op, targetId: randomUUID() },
          }),
          JSON.stringify(op),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      const access =
        await pool.query(`SELECT has_function_privilege('anon','resupply.tenant_lifecycle_command(jsonb,jsonb)','EXECUTE') AS anon,
      has_function_privilege('authenticated','resupply.tenant_lifecycle_command(jsonb,jsonb)','EXECUTE') AS authenticated,
      has_function_privilege('service_role','resupply.tenant_lifecycle_command(jsonb,jsonb)','EXECUTE') AS service,
      has_function_privilege('service_role','resupply_private.write_tenant_lifecycle_status(text,uuid,text,text,timestamptz)','EXECUTE') AS writer,
      has_table_privilege('service_role','resupply_private.tenant_lifecycle_intents','SELECT') AS receipts`);
      expect(access.rows[0]).toEqual({
        anon: false,
        authenticated: false,
        service: true,
        writer: false,
        receipts: false,
      });
    });
    it("serializes duplicate apply and rejects a concurrent stale review", async () => {
      const f = await fixture();
      const first = await f.preview();
      const second = await f.preview();
      const replies = await Promise.all([
        f.call(apply(first)),
        f.call(apply(first)),
      ]);
      expect(replies[1]).toEqual(replies[0]);
      await expect(f.call(apply(second))).rejects.toMatchObject({
        code: "40001",
      });
      const count = await pool.query(
        "SELECT count(*)::int AS count FROM resupply_private.tenant_lifecycle_intents WHERE target_id=$1 AND result IS NOT NULL",
        [f.targetId],
      );
      expect(count.rows[0].count).toBe(1);
    });
    it.each(["preview", "assurance"])(
      "rechecks wall-clock %s expiry after waiting for the organization lock",
      async (kind) => {
        const f = await fixture();
        let preview = await f.preview();
        if (kind === "preview") {
          // A separately inserted historical receipt fixture, retaining the same
          // five-minute review interval; immutable production rows are never edited.
          const saved = await pool.query(
            `INSERT INTO resupply_private.tenant_lifecycle_intents(command_id,request_id,hub_user_id,native_user_id,session_id,target_id,before_target,suspended,reason,preview_digest,created_at,expires_at)
        SELECT gen_random_uuid(),gen_random_uuid(),hub_user_id,native_user_id,session_id,target_id,before_target,suspended,reason,preview_digest,
          stamp.at-interval '299 seconds',stamp.at+interval '1 second' FROM resupply_private.tenant_lifecycle_intents CROSS JOIN (SELECT clock_timestamp() AS at OFFSET 0) stamp WHERE command_id=$1 RETURNING command_id`,
            [preview.commandId],
          );
          preview = { ...preview, commandId: saved.rows[0].command_id };
        }
        const lock = await pool.connect();
        const waiter = await pool.connect();
        const waitBlocked = await blocked(waiter);
        let outcome: Promise<unknown> | undefined;
        try {
          await lock.query("BEGIN");
          await lock.query(
            "SELECT 1 FROM resupply.organizations WHERE id=$1 FOR UPDATE",
            [f.targetId],
          );
          const expires = new Date(Date.now() + 1000).toISOString();
          outcome = f
            .call(
              apply(preview),
              kind === "assurance" ? { assurance_expires_at: expires } : {},
              waiter,
            )
            .then(
              (result) => ({ result }),
              (error) => ({ code: error.code }),
            );
          await waitBlocked();
          await new Promise((resolve) => setTimeout(resolve, 1100));
          await lock.query("COMMIT");
          expect(await outcome).toEqual({
            code: kind === "preview" ? "40001" : "28000",
          });
          expect(await status(f.targetId)).toBe("active");
        } finally {
          await lock.query("ROLLBACK");
          await outcome;
          lock.release();
          waiter.release();
        }
      },
      10000,
    );

    it.skipIf(!httpReady)(
      "composes actual HTTP handler, single-use SMS issuer and real service-role PostgREST writer",
      async () => {
        const url = process.env.SUPABASE_URL!;
        if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname))
          throw Error("Local PostgREST only");
        const f = await fixture();
        const tickets = new Map<string, Record<string, unknown>>();
        let rpcCount = 0;
        const realFetch = globalThis.fetch;
        const issuer = async (input: RequestInfo | URL, init?: RequestInit) => {
          expect(String(input)).toBe(
            "https://support-hub-web-production.up.railway.app/api/internal/command/breathe/authorize",
          );
          const token = new Headers(init?.headers).get("authorization")!;
          const operation = tickets.get(token);
          tickets.delete(token);
          if (!operation)
            return Response.json(
              { error: { code: "unauthenticated" } },
              { status: 401 },
            );
          const { native_user_id: _native, ...actor } = f.actor;
          return Response.json({ ...actor, operation });
        };
        const handler = createTenantLifecycleHandler({
          getEnv: (name) =>
            ({
              CAREMETRIC_ADMIN_ENABLED: "true",
              CAREMETRIC_ADMIN_TENANT_COMMANDS_ENABLED: "true",
              HUB_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
              CAREMETRIC_ADMIN_IDENTITY_MAP_JSON: JSON.stringify({
                [f.hubId]: f.nativeId,
              }),
            })[name],
          fetcher: issuer as typeof fetch,
          getClient: async () =>
            getSupabaseServiceRoleClient({
              url,
              serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
            }),
        });
        const server = createServer(async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const reply = await handler(
            new Request(
              "https://cmbreathe.com/resupply-api/central-admin/tenant-lifecycle",
              {
                method: "POST",
                headers: {
                  Authorization: req.headers.authorization ?? "",
                  "Content-Type": "application/json",
                },
                body: Buffer.concat(chunks),
              },
            ),
          );
          res.writeHead(reply.status, Object.fromEntries(reply.headers));
          res.end(await reply.text());
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (!address || typeof address === "string")
          throw Error("HTTP fixture address");
        const send = async (
          operation: Record<string, unknown>,
          token?: string,
        ) => {
          const authorization =
            token ??
            `Bearer cmh_${Buffer.from(randomUUID()).toString("base64url").slice(0, 43)}`;
          if (!token) tickets.set(authorization, operation);
          rpcCount++;
          return realFetch(`http://127.0.0.1:${address.port}`, {
            method: "POST",
            headers: {
              Authorization: authorization,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(operation),
          });
        };
        try {
          const context = await (
            await send({ domain, operation: "context", targetId: f.targetId })
          ).json();
          expect(context.data.target.id).toBe(f.targetId);
          const previewResponse = await send({
            domain,
            operation: "preview",
            requestId: randomUUID(),
            targetId: f.targetId,
            action: "organizations.setSuspension",
            parameters: { suspended: true },
            expectedRevision: context.data.target.revision,
            reason: "Reviewed through real HTTP transport",
          });
          expect(previewResponse.status).toBe(200);
          const preview = (await previewResponse.json()).data;
          const done = await send(apply(preview));
          expect(done.status).toBe(200);
          const result = (await done.json()).data;
          expect(result.result.afterStatus).toBe("suspended");
          expect(
            (
              await (
                await send({
                  domain,
                  operation: "resume",
                  requestId: preview.requestId,
                })
              ).json()
            ).data.result,
          ).toEqual(result.result);
          expect(
            (await send(apply(preview), `Bearer cmh_${"z".repeat(43)}`)).status,
          ).toBe(401);
          await pool.query(
            "DELETE FROM resupply.platform_admins WHERE auth_user_id=$1",
            [f.nativeId],
          );
          expect((await send(apply(preview))).status).toBe(403);
          expect(rpcCount).toBe(6);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
  },
);
