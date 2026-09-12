import { z } from "zod";
import {
  assertNativePlatformAdministrator,
  boundedJson,
  CentralAdminError,
  centralAdminNativeClient,
  readCentralAdminConfig,
  untilAbort,
  type CentralAdminOptions,
} from "./central-admin";
import { invalidateBrandingCache } from "./tenant-branding";
import {
  lifecycleInstant,
  lifecycleUuid,
  projectTenantLifecycleResult,
  tenantLifecycleDomain,
  tenantLifecycleOperation,
  type TenantLifecycleOperation,
} from "./tenant-lifecycle-protocol";

const HUB_AUTHORIZE =
  "https://support-hub-web-production.up.railway.app/api/internal/command/breathe/authorize";
const proofSchema = z
  .object({
    user_id: lifecycleUuid,
    role: z.literal("platform_admin"),
    method: z.literal("sms"),
    session_id: lifecycleUuid,
    session_started_at: lifecycleInstant,
    assurance_expires_at: lifecycleInstant,
    operation: tenantLifecycleOperation,
  })
  .strict();

export function lifecycleDatabaseError(
  error: { code?: string } | null,
): CentralAdminError {
  switch (error?.code) {
    case "42501":
      return new CentralAdminError(403, "forbidden");
    case "28000":
      return new CentralAdminError(401, "unauthenticated");
    case "P0002":
      return new CentralAdminError(404, "not_found");
    case "40001":
      return new CentralAdminError(409, "conflict");
    case "22023":
    case "22P02":
    case "22007":
    case "22008":
      return new CentralAdminError(400, "invalid_request");
    default:
      return new CentralAdminError(503, "upstream");
  }
}

function currentProof(proof: z.infer<typeof proofSchema>, now: Date) {
  const started = Date.parse(proof.session_started_at);
  const expires = Date.parse(proof.assurance_expires_at);
  if (
    started > now.getTime() + 300000 ||
    expires <= now.getTime() ||
    expires <= started ||
    expires > started + 28800000
  )
    throw new CentralAdminError(401, "unauthenticated");
}

/** No native login is minted. A single-use, exact-operation Hub proof is
 * consumed before the mapped native identity and the atomic writer run. */
export function createTenantLifecycleHandler({
  getEnv = (name) => process.env[name],
  getClient = centralAdminNativeClient,
  fetcher = fetch,
  now = () => new Date(),
}: CentralAdminOptions = {}) {
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: {
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  return async (request: Request): Promise<Response> => {
    try {
      const config = readCentralAdminConfig(getEnv);
      if (
        !config.enabled ||
        getEnv("CAREMETRIC_ADMIN_TENANT_COMMANDS_ENABLED") !== "true"
      )
        throw new CentralAdminError(503, "unconfigured");
      if (request.method !== "POST")
        throw new CentralAdminError(405, "method_not_allowed");
      if (request.headers.has("origin") || request.headers.has("cookie"))
        throw new CentralAdminError(403, "forbidden");
      if (new URL(request.url).search)
        throw new CentralAdminError(400, "invalid_request");
      if (
        request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        throw new CentralAdminError(415, "unsupported_content_type");
      const authorization = request.headers.get("authorization") ?? "";
      if (!/^Bearer cmh_[A-Za-z0-9_-]{43}$/.test(authorization))
        throw new CentralAdminError(401, "unauthenticated");
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(12000),
      ]);
      // Bound the complete operation, including a stalled client acquisition,
      // authorization response and native database response.
      return await untilAbort(
        (async () => {
          let operation: TenantLifecycleOperation;
          try {
            operation = tenantLifecycleOperation.parse(
              await boundedJson(request, 16384, signal),
            );
          } catch {
            throw new CentralAdminError(400, "invalid_request");
          }
          const auth = await fetcher(HUB_AUTHORIZE, {
            method: "POST",
            headers: {
              Authorization: authorization,
              "Content-Type": "application/json",
            },
            body: "{}",
            redirect: "error",
            signal,
          });
          if (!auth.ok) {
            void auth.body?.cancel().catch(() => undefined);
            throw new CentralAdminError(
              auth.status === 401 ? 401 : auth.status === 403 ? 403 : 503,
              auth.status === 401
                ? "unauthenticated"
                : auth.status === 403
                  ? "forbidden"
                  : "upstream",
            );
          }
          const proof = proofSchema.safeParse(
            await boundedJson(auth, 32768, signal),
          );
          if (
            !proof.success ||
            JSON.stringify(proof.data.operation) !== JSON.stringify(operation)
          )
            throw new CentralAdminError(403, "forbidden");
          currentProof(proof.data, now());
          const nativeId = config.identities!.get(proof.data.user_id);
          if (!nativeId) throw new CentralAdminError(403, "forbidden");
          const raw = await untilAbort(getClient(), signal);
          await assertNativePlatformAdministrator(raw, nativeId, signal);
          signal.throwIfAborted();
          currentProof(proof.data, now());
          const result = await raw
            .schema("resupply")
            .rpc("tenant_lifecycle_command", {
              p_actor: { ...proof.data, native_user_id: nativeId },
              p_operation: operation,
            })
            .abortSignal(signal);
          if (result.error) throw lifecycleDatabaseError(result.error);
          // The transaction may have committed even if the caller loses current
          // authority immediately afterwards. Invalidate local caches first;
          // no receipt is disclosed without the fresh checks below.
          if (operation.operation === "apply") invalidateBrandingCache();
          const data = projectTenantLifecycleResult(result.data, operation);
          await assertNativePlatformAdministrator(raw, nativeId, signal);
          signal.throwIfAborted();
          currentProof(proof.data, now());
          const body = {
            contractVersion: 1,
            product: "breathe",
            domain: tenantLifecycleDomain,
            operation: operation.operation,
            generatedAt: now().toISOString(),
            data,
          };
          if (Buffer.byteLength(JSON.stringify(body)) > 131072)
            throw new CentralAdminError(503, "upstream");
          return json(body);
        })(),
        signal,
      );
    } catch (error) {
      // Never log or return upstream bodies, tokens, identity rows or reasons.
      return json(
        {
          error: {
            code: error instanceof CentralAdminError ? error.code : "upstream",
          },
        },
        error instanceof CentralAdminError ? error.status : 503,
      );
    }
  };
}

/** Existing cookie/CSRF platform routes use the same native SQL status writer.
 * The route's original transitions are preserved; Hub commands add review/CAS. */
export async function setNativeTenantStatus(
  nativeUserId: string,
  targetId: string,
  status: "active" | "suspended",
) {
  const signal = AbortSignal.timeout(12000);
  return untilAbort(
    (async () => {
      const raw = await untilAbort(centralAdminNativeClient(), signal);
      signal.throwIfAborted();
      const result = await raw
        .schema("resupply")
        .rpc("set_tenant_lifecycle_status", {
          p_native_user_id: nativeUserId,
          p_target_id: targetId,
          p_next_status: status,
        })
        .abortSignal(signal);
      if (result.error) throw lifecycleDatabaseError(result.error);
      invalidateBrandingCache();
      const row = z
        .object({
          id: z.literal(targetId),
          slug: z.string(),
          name: z.string().nullable(),
          storefront_name: z.string().nullable(),
          status: z.literal(status),
          custom_domain: z.string().nullable(),
          custom_domain_status: z.string(),
          created_at: z.string(),
        })
        .strict()
        .parse(result.data);
      signal.throwIfAborted();
      return row;
    })(),
    signal,
  );
}
