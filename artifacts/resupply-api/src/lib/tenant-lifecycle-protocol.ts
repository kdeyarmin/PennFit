import { z } from "zod";

export const tenantLifecycleDomain = "tenant.lifecycle.v1";
export const tenantLifecycleAction = "organizations.setSuspension";
export const tenantLifecycleCapabilities = [
  "organizations.lifecycle.context",
  "organizations.lifecycle.preview",
  "organizations.lifecycle.apply",
  "organizations.lifecycle.resume",
] as const;
export const lifecycleUuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const lifecycleDigest = z.string().regex(/^[0-9a-f]{64}$/);
export const lifecycleInstant = z.string().datetime({ offset: true }).max(100);
const reason = z
  .string()
  .min(10)
  .max(500)
  .refine((value) => value === value.trim() && !/\p{Cc}/u.test(value));
const parameters = z.object({ suspended: z.boolean() }).strict();
export const tenantLifecycleOperation = z.discriminatedUnion("operation", [
  z
    .object({
      domain: z.literal(tenantLifecycleDomain),
      operation: z.literal("context"),
      targetId: lifecycleUuid,
    })
    .strict(),
  z
    .object({
      domain: z.literal(tenantLifecycleDomain),
      operation: z.literal("preview"),
      requestId: lifecycleUuid,
      targetId: lifecycleUuid,
      action: z.literal(tenantLifecycleAction),
      parameters,
      expectedRevision: lifecycleDigest,
      reason,
    })
    .strict(),
  z
    .object({
      domain: z.literal(tenantLifecycleDomain),
      operation: z.literal("apply"),
      commandId: lifecycleUuid,
      expectedDigest: lifecycleDigest,
    })
    .strict(),
  z
    .object({
      domain: z.literal(tenantLifecycleDomain),
      operation: z.literal("resume"),
      requestId: lifecycleUuid,
    })
    .strict(),
]);
export type TenantLifecycleOperation = z.infer<typeof tenantLifecycleOperation>;
const status = z.enum(["active", "suspended", "archived"]);
export const tenantLifecycleTarget = z
  .object({
    id: lifecycleUuid,
    slug: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
    name: z.string().max(1000).nullable(),
    status,
    updatedAt: lifecycleInstant.nullable(),
    seedProtected: z.boolean(),
    revision: lifecycleDigest,
  })
  .strict();
export type TenantLifecycleTarget = z.infer<typeof tenantLifecycleTarget>;
export const tenantLifecycleReceipt = z
  .object({
    commandId: lifecycleUuid,
    requestId: lifecycleUuid,
    targetId: lifecycleUuid,
    action: z.literal(tenantLifecycleAction),
    beforeStatus: z.enum(["active", "suspended"]),
    afterStatus: z.enum(["active", "suspended"]),
    appliedAt: lifecycleInstant,
    revision: lifecycleDigest,
  })
  .strict()
  .refine((value) => value.beforeStatus !== value.afterStatus);
export type TenantLifecycleReceipt = z.infer<typeof tenantLifecycleReceipt>;
export const tenantLifecyclePreview = z
  .object({
    commandId: lifecycleUuid,
    requestId: lifecycleUuid,
    action: z.literal(tenantLifecycleAction),
    targetId: lifecycleUuid,
    parameters,
    reason,
    createdAt: lifecycleInstant,
    expiresAt: lifecycleInstant,
    previewDigest: lifecycleDigest,
    before: tenantLifecycleTarget,
    after: z.object({ status: z.enum(["active", "suspended"]) }).strict(),
    canApplyThisSession: z.boolean(),
    result: tenantLifecycleReceipt.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.targetId === value.before.id &&
      value.before.status !== "archived" &&
      value.before.status !== value.after.status &&
      value.after.status ===
        (value.parameters.suspended ? "suspended" : "active") &&
      (!value.parameters.suspended || !value.before.seedProtected) &&
      Date.parse(value.expiresAt) > Date.parse(value.createdAt) &&
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt) + 300001 &&
      (!value.result ||
        (!value.canApplyThisSession &&
          value.result.commandId === value.commandId &&
          value.result.requestId === value.requestId &&
          value.result.targetId === value.targetId &&
          value.result.beforeStatus === value.before.status &&
          value.result.afterStatus === value.after.status)),
  );
export type TenantLifecyclePreview = z.infer<typeof tenantLifecyclePreview>;
export const tenantLifecycleContext = z
  .object({
    target: tenantLifecycleTarget,
    requests: z.array(tenantLifecyclePreview).max(20),
  })
  .strict()
  .refine(
    (value) =>
      value.requests.every((item) => item.targetId === value.target.id) &&
      new Set(value.requests.map((item) => item.requestId)).size ===
        value.requests.length,
  );
export type TenantLifecycleContext = z.infer<typeof tenantLifecycleContext>;

export function projectTenantLifecycleResult(
  input: unknown,
  operation: TenantLifecycleOperation,
) {
  if (operation.operation === "context") {
    const context = tenantLifecycleContext.parse(input);
    if (context.target.id !== operation.targetId)
      throw Error("Tenant target differs");
    return context;
  }
  const preview = tenantLifecyclePreview.parse(input);
  if (
    operation.operation === "preview" &&
    (preview.requestId !== operation.requestId ||
      preview.targetId !== operation.targetId ||
      preview.reason !== operation.reason ||
      preview.parameters.suspended !== operation.parameters.suspended ||
      preview.before.revision !== operation.expectedRevision)
  )
    throw Error("Tenant preview differs");
  if (
    operation.operation === "apply" &&
    (preview.commandId !== operation.commandId ||
      preview.previewDigest !== operation.expectedDigest ||
      !preview.result)
  )
    throw Error("Tenant result differs");
  if (
    operation.operation === "resume" &&
    preview.requestId !== operation.requestId
  )
    throw Error("Tenant request differs");
  return preview;
}
