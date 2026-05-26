#!/usr/bin/env bash
#
# Git merge driver for pnpm-lock.yaml. LOCAL-ONLY: wired up by
# scripts/install-hooks.sh, which registers a `merge.pnpm-lock` driver in
# the clone's local git config and points pnpm-lock.yaml at it via
# .git/info/attributes (that file overrides the committed .gitattributes,
# and is never committed — so this only affects the local checkout).
#
# Why local-only: the committed .gitattributes deliberately keeps
# `pnpm-lock.yaml -diff merge=binary`. A custom driver can't run on
# GitHub's server-side merge, and letting GitHub fall back to a 3-way
# text merge of a lockfile risks a silently-corrupt auto-merge landing on
# main. `binary` keeps GitHub treating lockfile divergence as a conflict
# you must resolve (safe). This driver just makes the LOCAL resolution
# painless.
#
# What it does: a lockfile conflict is almost never worth resolving by
# hand — `pnpm install` regenerates the file deterministically from the
# merged package.json set no matter which side we start from. So we take
# the incoming ("theirs") version, exit 0 (merge resolved, no halt), and
# let the post-merge / post-rewrite hooks run `pnpm install` to reconcile.
#
# Args come from the driver config string "%O %A %B":
#   $1 = %O  ancestor version       (unused — we do not 3-way merge)
#   $2 = %A  our version, AND the path the result must be written to
#   $3 = %B  their (incoming) version
set -euo pipefail

output="$2"
theirs="$3"

cp -- "$theirs" "$output"
exit 0
