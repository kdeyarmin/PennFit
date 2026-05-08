// Hand-rolled fetch wrappers for the admin message-templates
// endpoints. Mirrors the csr-macros-api pattern.
//
// Phase 1 of docs/proposals/customer-message-templates.md exposes
// only GET / GET-one / PATCH — templates are seeded by code paired
// with each renderer migration, so there's no POST or DELETE on
// purpose. isActive=false is the soft-delete path.

export type TemplateChannel = "email" | "sms" | "voice" | "push";

export interface MessageTemplate {
  id: string;
  templateKey: string;
  channel: TemplateChannel;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string;
  allowedVariables: string[];
  isActive: boolean;
  updatedAt: string;
  updatedBy: string | null;
  createdAt: string;
  createdBy: string | null;
}

const BASE = "/resupply-api/admin/message-templates";

export interface ListTemplatesOpts {
  templateKey?: string;
  channel?: TemplateChannel;
  includeInactive?: boolean;
}

export async function listTemplates(
  opts: ListTemplatesOpts = {},
): Promise<{ templates: MessageTemplate[] }> {
  const qs = new URLSearchParams();
  if (opts.templateKey) qs.set("templateKey", opts.templateKey);
  if (opts.channel) qs.set("channel", opts.channel);
  if (opts.includeInactive) qs.set("includeInactive", "1");
  const res = await fetch(
    `${BASE}${qs.toString() ? `?${qs.toString()}` : ""}`,
    { credentials: "include", headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`Failed to load message templates (${res.status})`);
  }
  return (await res.json()) as { templates: MessageTemplate[] };
}

export async function getTemplate(
  id: string,
): Promise<{ template: MessageTemplate }> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load message template (${res.status})`);
  }
  return (await res.json()) as { template: MessageTemplate };
}

export interface PatchTemplateBody {
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string;
  isActive?: boolean;
}

export class TemplatePatchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** When the API rejects with `disallowed_variables`, the offending
     *  placeholder names + the row's allowedVariables for hinting. */
    public readonly disallowed?: string[],
    public readonly allowed?: string[],
  ) {
    super(message);
    this.name = "TemplatePatchError";
  }
}

export async function patchTemplate(
  id: string,
  body: PatchTemplateBody,
): Promise<{ template: MessageTemplate }> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
      offending?: string[];
      allowed?: string[];
    } | null;
    throw new TemplatePatchError(
      json?.message ?? json?.error ?? `Patch failed (${res.status})`,
      res.status,
      json?.offending,
      json?.allowed,
    );
  }
  return (await res.json()) as { template: MessageTemplate };
}
