#!/usr/bin/env bash
# install-claude-skills.sh
# Installs 14 Claude Code skills as personal skills at ~/.claude/skills/
# After running, every project on this machine sees these skills.
#
# Run on:
#   - WSL / Linux / macOS / Git Bash on Windows
#   - Re-run any time; it overwrites in place (idempotent).
#
# Requires: git, bash 4+, find, cp

set -euo pipefail

SKILLS_DIR="${HOME}/.claude/skills"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$SKILLS_DIR"

REPOS=(
  "pbakaus/impeccable"                    # 1.  Design audit & polish
  "OthmanAdi/planning-with-files"         # 2.  Persistent task management
  "blader/humanizer"                      # 3.  Remove AI writing tells
  "Lum1104/Understand-Anything"           # 4.  Codebase knowledge graphs
  "SawyerHood/dev-browser"                # 5.  Real browser for Claude
  "trailofbits/skills"                    # 6.  Security suite (multiple skills)
  "lackeyjb/playwright-skill"             # 7.  Browser automation / testing
  "htdt/godogen"                          # 8.  Godot game generator
  "NeoLabHQ/context-engineering-kit"      # 9.  Context engineering patterns
  "DrCatHicks/learning-opportunities"     # 10. Deliberate skill development
  "slavingia/skills"                      # 11. Entrepreneur skills (multiple)
  "iannuttall/claude-sessions"            # 12. Session tracking
  "coleam00/second-brain-skills"          # 13. Second-brain toolkit
  "nidhinjs/prompt-master"                # 14. Meta: prompt writing
)

# install_skill_from_repo clones the given GitHub repo slug and copies any directories containing `SKILL.md` into the user's Claude skills directory (`~/.claude/skills`) — using the repo name for root-level skills or the containing folder name for nested skills — and if no `SKILL.md` is found copies the entire repository; the function skips the repo on clone failure.
install_skill_from_repo() {
  local repo="$1"
  local repo_name="${repo##*/}"
  local clone_dir="${TMP_DIR}/${repo_name}"

  printf '\n→ %s\n' "$repo"

  if ! git clone --depth 1 --quiet "https://github.com/${repo}.git" "$clone_dir" 2>/dev/null; then
    printf '  ✗ clone failed — skipping\n'
    return 0
  fi

  # Find every SKILL.md in the repo (skip hidden dirs, node_modules, vendored deps)
  local skill_files=()
  while IFS= read -r line; do
    skill_files+=("$line")
  done < <(find "$clone_dir" \
              -name SKILL.md \
              -not -path '*/.*' \
              -not -path '*/node_modules/*' \
              -not -path '*/vendor/*' 2>/dev/null)

  if [[ ${#skill_files[@]} -eq 0 ]]; then
    # No SKILL.md anywhere — install the whole repo as one folder
    # so you can inspect / adapt it manually.
    printf '  ⚠ no SKILL.md found — installing repo as-is to %s/\n' "$repo_name"
    rm -rf "${SKILLS_DIR:?}/${repo_name}"
    cp -R "$clone_dir" "${SKILLS_DIR}/${repo_name}"
    rm -rf "${SKILLS_DIR}/${repo_name}/.git"
    return 0
  fi

  for skill_md in "${skill_files[@]}"; do
    local skill_src skill_name dest
    skill_src="$(dirname "$skill_md")"

    if [[ "$skill_src" == "$clone_dir" ]]; then
      # SKILL.md is at the repo root — use the repo name
      skill_name="$repo_name"
    else
      # SKILL.md is nested — use its containing directory name
      skill_name="$(basename "$skill_src")"
    fi

    dest="${SKILLS_DIR}/${skill_name}"
    rm -rf "$dest"
    cp -R "$skill_src" "$dest"
    rm -rf "$dest/.git"
    printf '  ✓ %s\n' "$skill_name"
  done
}

printf 'Installing personal Claude Code skills to: %s\n' "$SKILLS_DIR"

for repo in "${REPOS[@]}"; do
  install_skill_from_repo "$repo"
done

printf '\n──────────────────────────────────────────\n'
printf 'Done. Skills now in %s:\n\n' "$SKILLS_DIR"
ls -1 "$SKILLS_DIR" | sed 's/^/  /'
printf '\nRestart any active Claude Code sessions to load the new skills.\n'
printf 'Type /skills inside a session to confirm they loaded.\n'
