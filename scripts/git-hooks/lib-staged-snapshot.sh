#!/usr/bin/env bash
# Provides with_staged_snapshot() — runs a command against a working
# tree that mirrors EXACTLY the staged index, then restores the
# original working tree (unstaged edits + untracked files included).
#
# Why this exists:
#   The pre-commit hook used to invoke its checks against the live
#   working tree. That meant:
#     - unstaged edits to a generated/spec file could mask drift the
#       commit actually introduces (false negative, the worst kind),
#     - unstaged edits could ALSO trigger drift the commit doesn't
#       introduce (false positive), forcing the developer to abort
#       and re-stash by hand to figure out what was real.
#   Stashing everything-but-the-index produces a working tree that's
#   byte-identical to "what's about to land", so the checks see
#   exactly the commit being made.
#
# Why this isn't just `git stash --keep-index`:
#   That command's stash entry contains the FULL working-tree-vs-HEAD
#   diff (staged + unstaged). On pop, git tries to merge it back on
#   top of a working tree that already holds the staged content,
#   producing a content conflict on every file the user both staged
#   and further modified. So instead this implementation captures the
#   unstaged delta as a patch (`git diff`) and the untracked files
#   as a tar archive, wipes them, runs the command, and restores
#   from those two artifacts. This is the same pattern the upstream
#   `pre-commit` framework uses and it's reliable for binary files,
#   mode changes, deletions, and partially-staged hunks.
#
# Public API:
#   with_staged_snapshot CMD [ARGS…]
#     - Capture and clear the unstaged delta + untracked files.
#     - Run CMD with the working tree mirroring the index.
#     - Restore the captured state UNCONDITIONALLY (success, failure,
#       Ctrl-C, SIGTERM — see "Signal safety" below).
#     - Return CMD's exit code (or 1 if restoration itself failed).
#
#   Contract: rely only on CMD's EXIT CODE. When isolation is active
#   the wrapped command runs in a subshell (required for signal-safe
#   restoration), so any caller-scope variables CMD sets will not be
#   visible after the wrapper returns. Communicate state out via a
#   tempfile if you need it.
#
# Skipped when:
#   - We're in the middle of a merge / rebase / cherry-pick / revert.
#     Mutating the working tree during those operations is hostile
#     to the in-progress state machine. We fall back to checking the
#     live working tree and print one warning line so the developer
#     knows the snapshot wasn't isolated for this run.
#   - There's nothing to capture (clean except for the index). Treated
#     as a fast-path no-op pass-through.
#
# Failure modes (and why each one is what it is):
#   - Capture failure (git diff / git ls-files / tar archive of
#     untracked files): we ABORT the commit (return non-zero). The
#     fall-back of "just check the live tree" would silently re-
#     introduce the false-negative bug Task #15 was filed to fix —
#     a hook that lies is worse than one that fails loudly.
#   - Mid-run interruption (Ctrl-C, SIGTERM): a trap fires the same
#     restoration path the happy case uses. The user always gets
#     their work back.
#   - Restoration failure: we leave the patch + tar on disk and
#     print loud, copy-pasteable recovery commands. The user's work
#     is never lost — it's saved in well-named files under a temp
#     dir that is NOT cleaned up on this code path.
#
# Signal safety:
#   Once isolation begins (untracked files removed or
#   `git checkout-index -a -f` run) every code path back out of the
#   subshell goes through the EXIT trap, which calls
#   _staged_snapshot_restore. INT/TERM are explicitly trapped so the
#   shell exits cleanly (firing EXIT) instead of dying without
#   restoration.

with_staged_snapshot() {
  local tmpdir
  tmpdir="$(mktemp -d -t staged-snapshot.XXXXXX)"

  local repo_root
  if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    printf '[staged-snapshot] WARNING: not in a git repo; checking working tree as-is\n' >&2
    rm -rf "$tmpdir"
    if "$@"; then return 0; else return $?; fi
  fi

  if _staged_snapshot_in_complex_state; then
    printf '[staged-snapshot] in-progress merge/rebase/cherry-pick detected; checking working tree as-is\n' >&2
    rm -rf "$tmpdir"
    if "$@"; then return 0; else return $?; fi
  fi

  local patch_file="$tmpdir/unstaged.patch"
  local untracked_list="$tmpdir/untracked.list"
  local untracked_tar="$tmpdir/untracked.tar"
  local status_file="$tmpdir/restore.status"

  # ---- CAPTURE PHASE — no mutations yet. Hard-fail on any error.
  # Falling through to "check the live tree" would silently re-
  # introduce the false-negative bug this whole library exists to
  # prevent. A hook that lies is worse than one that fails loudly.

  if ! ( cd "$repo_root" && git diff --binary --no-color --no-ext-diff > "$patch_file" ); then
    printf '[staged-snapshot] ERROR: failed to capture unstaged diff; aborting commit\n' >&2
    rm -rf "$tmpdir"
    return 1
  fi
  if ! ( cd "$repo_root" && git ls-files --others --exclude-standard -z > "$untracked_list" ); then
    printf '[staged-snapshot] ERROR: failed to enumerate untracked files; aborting commit\n' >&2
    rm -rf "$tmpdir"
    return 1
  fi

  local has_patch=0 has_untracked=0
  [[ -s "$patch_file" ]] && has_patch=1
  [[ -s "$untracked_list" ]] && has_untracked=1

  # Fast path: nothing to isolate. Working tree already mirrors index.
  if [[ $has_patch -eq 0 && $has_untracked -eq 0 ]]; then
    rm -rf "$tmpdir"
    if "$@"; then return 0; else return $?; fi
  fi

  # Archive untracked files BEFORE deleting any of them (so even if
  # archival fails we haven't lost anything yet). Hard-fail on error
  # for the same reason as above.
  if [[ $has_untracked -eq 1 ]]; then
    if ! ( cd "$repo_root" && tar -cf "$untracked_tar" --null -T "$untracked_list" ) 2>/dev/null; then
      printf '[staged-snapshot] ERROR: failed to archive untracked files; aborting commit\n' >&2
      rm -rf "$tmpdir"
      return 1
    fi
  fi

  # Announce the snapshot directory BEFORE we mutate anything. If
  # the process is killed with SIGKILL (or the host loses power)
  # between mutation and restore, the user has no trap to fall back
  # on — but they at least have this line in their terminal scroll-
  # back, so they know exactly where the recovery artifacts are.
  printf '[staged-snapshot] isolating staged index (recovery dir: %s)\n' "$tmpdir" >&2

  # ---- MUTATE + RUN PHASE — runs in a subshell with a trap, so
  # ANY exit (Ctrl-C, SIGTERM, the wrapped command crashing, set -e
  # tripping inside the wrapped command, etc.) goes through the
  # restoration path. The EXIT trap fires after the explicit signal
  # traps because those traps `exit` rather than letting the shell
  # die uncleanly.
  (
    # Make state available to the trap via well-named env vars
    # rather than a quoted argument list (no quoting hazards).
    STAGED_SNAPSHOT_TMPDIR="$tmpdir"
    STAGED_SNAPSHOT_REPO_ROOT="$repo_root"
    STAGED_SNAPSHOT_HAS_PATCH="$has_patch"
    STAGED_SNAPSHOT_HAS_UNTRACKED="$has_untracked"
    STAGED_SNAPSHOT_STATUS_FILE="$status_file"

    trap _staged_snapshot_restore EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    # Use set -e ONLY around the mutations themselves. If untracked
    # removal or checkout-index errors, we exit non-zero — the EXIT
    # trap then runs restore (untracked files come back from the tar
    # we already saved; tracked files come back via git apply onto
    # whatever state we left).
    set -e
    if [[ $has_untracked -eq 1 ]]; then
      ( cd "$repo_root" && xargs -0 rm -f -- < "$untracked_list" )
    fi
    if [[ $has_patch -eq 1 ]]; then
      ( cd "$repo_root" && git checkout-index -a -f )
    fi
    set +e

    "$@"
  )
  local ret=$?

  # The trap wrote a single-line status indicating whether
  # restoration was clean. If absent, treat as failure (the trap
  # didn't get to write — extremely rare, but be defensive).
  local restore_status=1
  if [[ -f "$status_file" ]]; then
    restore_status="$(cat "$status_file" 2>/dev/null || printf 1)"
  fi

  if [[ "$restore_status" != "0" ]]; then
    cat >&2 <<EOF

[staged-snapshot] FAILED to fully restore your working tree.
[staged-snapshot] Your work is NOT lost — recover with:

EOF
    if [[ $has_patch -eq 1 ]]; then
      printf '[staged-snapshot]   git apply %q\n' "$patch_file" >&2
    fi
    if [[ $has_untracked -eq 1 ]]; then
      printf '[staged-snapshot]   tar -xf %q -C %q\n' "$untracked_tar" "$repo_root" >&2
    fi
    printf '\n' >&2
    # Preserve the wrapped command's exit code if any; otherwise
    # surface the restoration failure as a non-zero return.
    [[ $ret -eq 0 ]] && ret=1
    # Deliberately leave $tmpdir behind so the artifacts above exist.
    return $ret
  fi

  rm -rf "$tmpdir"
  return $ret
}

# Trap handler invoked from inside the with_staged_snapshot subshell.
# Reads its inputs from STAGED_SNAPSHOT_* env vars set immediately
# above the trap installation. Writes a one-character status file
# the parent shell consumes after the subshell exits (0=clean,
# anything else=restoration trouble).
_staged_snapshot_restore() {
  local sf=0
  if [[ "${STAGED_SNAPSHOT_HAS_PATCH:-0}" -eq 1 ]]; then
    if ! ( cd "$STAGED_SNAPSHOT_REPO_ROOT" && \
           git apply --whitespace=nowarn "$STAGED_SNAPSHOT_TMPDIR/unstaged.patch" ) 2>/dev/null; then
      sf=1
    fi
  fi
  if [[ "${STAGED_SNAPSHOT_HAS_UNTRACKED:-0}" -eq 1 ]]; then
    if ! ( cd "$STAGED_SNAPSHOT_REPO_ROOT" && \
           tar -xf "$STAGED_SNAPSHOT_TMPDIR/untracked.tar" ) 2>/dev/null; then
      sf=1
    fi
  fi
  printf '%d\n' "$sf" > "${STAGED_SNAPSHOT_STATUS_FILE}" 2>/dev/null || true
}

# Internal: returns 0 when git is in a state where mutating the
# working tree would interact badly with an in-progress operation.
_staged_snapshot_in_complex_state() {
  local git_dir
  git_dir="$(git rev-parse --git-dir 2>/dev/null)" || return 0
  [[ -e "$git_dir/MERGE_HEAD" ]] && return 0
  [[ -e "$git_dir/CHERRY_PICK_HEAD" ]] && return 0
  [[ -e "$git_dir/REVERT_HEAD" ]] && return 0
  [[ -d "$git_dir/rebase-apply" ]] && return 0
  [[ -d "$git_dir/rebase-merge" ]] && return 0
  return 1
}
