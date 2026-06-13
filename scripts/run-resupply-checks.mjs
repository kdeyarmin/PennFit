import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const CHECKS = [
  "scripts/check-resupply-architecture.sh",
  "scripts/check-admin-route-gates.sh",
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
