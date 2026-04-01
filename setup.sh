#!/bin/bash
# Setup script for running evalbuff evals on itself.
# Pass via: --init-command "bash setup.sh"

# Install dependencies
bun install

# Copy .env.local from the primary repo (gitignored, so absent in carved worktrees).
#
# Carved worktrees are local git clones created by eval-runner.ts via:
#   git clone --no-checkout "<primaryRepo>" "<tempDir>/repo"
# so `git remote get-url origin` resolves back to the primary repo path.
# For genuine git worktrees (not clones), fall back to the first worktree list entry.
MAIN_REPO="$(git remote get-url origin 2>/dev/null)"
if [ -z "$MAIN_REPO" ]; then
  MAIN_REPO="$(git worktree list | head -1 | awk '{print $1}')"
fi

if [ -f "$MAIN_REPO/.env.local" ]; then
  cp "$MAIN_REPO/.env.local" .env.local
fi
