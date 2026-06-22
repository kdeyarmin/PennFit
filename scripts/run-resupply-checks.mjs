import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const CHECKS = [
  "scripts/check-resupply-architecture.sh",
  "scripts/check-admin-route-gates.sh",
  // Multi-tenant isolation gate (Phase 0 workstream E1): the cutover is
  // complete, so this fails on ANY direct getSupabaseServiceRoleClient()
  // callsite in application code (reviewed global/auth callers exempt).
  // See check-tenant-isolation.sh.
  "scripts/check-tenant-isolation.sh",
  // Raw-escape-hatch org-scope gate: the chokepoint guard above only inspects
  // getOrgScopedClient() callsites, not the `.raw()` escape hatch downstream.
  // This fails on any `.raw()` read/write of a guarded tenant-scoped object
  // (public.orders, the fitter metrics views) that omits its org_id filter —
  // the exact class of leak that shipped twice. See check-raw-org-scope.sh.
  "scripts/check-raw-org-scope.sh",
];

function commandWorks(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
  });
  return result.status === 0;
}

function findBash() {
  const candidates = [
    process.env.BASH,
    process.env.SHELL,
    "bash",
    "sh",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (
      (candidate.includes("\\") || candidate.includes("/")) &&
      !existsSync(candidate)
    ) {
      continue;
    }
    if (commandWorks(candidate)) return candidate;
  }

  throw new Error(
    "Unable to find bash/sh to run resupply shell checks. Install Git Bash or run the checks in a Unix-like shell.",
  );
}

const bash = findBash();

for (const check of CHECKS) {
  const result = spawnSync(bash, [check], {
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
