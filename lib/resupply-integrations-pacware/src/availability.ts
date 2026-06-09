// PacWare exchange configuration + availability.
//
// Unlike the therapy-cloud adapters (which need vendor credentials to be
// "configured"), the PacWare exchange is a MANUAL FILE exchange: an
// operator runs a report in the PacWare client and uploads it, and
// downloads PennFit exports to import into PacWare. There are no
// credentials, so the surface is always available unless an operator
// explicitly disables it.
//
// Two optional env vars tune it:
//   PACWARE_EXCHANGE_DISABLED=1  — hide/disable the surface (kill switch).
//   PACWARE_FILE_OUTBOX_DIR=...  — when set, server-generated PacWare
//                                  files may also be written here for
//                                  automation / disaster recovery. The
//                                  interactive admin download path does
//                                  not require it.
//
// Browser-safe: `process.env` is read defensively so the barrel can be
// imported from a bundler without a Node global.

type EnvLike = Record<string, string | undefined>;

function defaultEnv(): EnvLike {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

export interface PacwareConfig {
  enabled: boolean;
  /** Absolute/relative dir for server-written exports, or null. */
  outboxDir: string | null;
}

export type PacwareAvailability =
  | {
      status: "configured";
      mode: "file_exchange";
      outboxConfigured: boolean;
    }
  | { status: "disabled"; reason: string };

export function readPacwareConfig(env: EnvLike = defaultEnv()): PacwareConfig {
  const disabled = env.PACWARE_EXCHANGE_DISABLED === "1";
  const outboxRaw = env.PACWARE_FILE_OUTBOX_DIR?.trim();
  return {
    enabled: !disabled,
    outboxDir: outboxRaw && outboxRaw !== "" ? outboxRaw : null,
  };
}

export function pacwareAvailability(
  env: EnvLike = defaultEnv(),
): PacwareAvailability {
  const cfg = readPacwareConfig(env);
  if (!cfg.enabled) {
    return { status: "disabled", reason: "PACWARE_EXCHANGE_DISABLED=1" };
  }
  return {
    status: "configured",
    mode: "file_exchange",
    outboxConfigured: cfg.outboxDir !== null,
  };
}
