#!/bin/bash
# Setup script for running evalbuff evals on itself.
# Pass via: --init-command "bash setup.sh"

# Install dependencies
bun install

# Copy .env.local from the main repo (gitignored, so not in worktrees)
MAIN_REPO="$(git worktree list | head -1 | awk '{print $1}')"
if [ -f "$MAIN_REPO/.env.local" ]; then
  cp "$MAIN_REPO/.env.local" .env.local
fi
