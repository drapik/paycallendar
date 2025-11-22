#!/usr/bin/env bash
set -euo pipefail

# Resolve repository root (directory containing this script is /run)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Create .env.local from example if it doesn't exist yet
if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    echo "Creating .env.local from .env.example"
    cp .env.example .env.local
  else
    echo "No .env.example found, creating empty .env.local"
    touch .env.local
  fi
else
  echo ".env.local already exists; skipping creation"
fi

# Inject Supabase secrets from current environment (if provided)
if [ -n "${SUPABASE_URL:-}" ]; then
  if grep -q "^SUPABASE_URL=" .env.local; then
    sed -i "s|^SUPABASE_URL=.*$|SUPABASE_URL=${SUPABASE_URL}|" .env.local
  else
    echo "SUPABASE_URL=${SUPABASE_URL}" >> .env.local
  fi
fi

if [ -n "${SUPABASE_KEY:-}" ]; then
  if grep -q "^SUPABASE_KEY=" .env.local; then
    sed -i "s|^SUPABASE_KEY=.*$|SUPABASE_KEY=${SUPABASE_KEY}|" .env.local
  else
    echo "SUPABASE_KEY=${SUPABASE_KEY}" >> .env.local
  fi
fi

# Install npm dependencies (idempotent)
echo "Installing npm dependencies"
npm install --no-fund --no-audit

# Print reminder if Supabase credentials are still empty
if grep -q "^SUPABASE_URL=$" .env.local || grep -q "^SUPABASE_KEY=$" .env.local; then
  cat <<'EOF_REMINDER'
Note: SUPABASE_URL or SUPABASE_KEY are empty in .env.local.
Fill them with your Supabase project URL and service role key before running the app.
EOF_REMINDER
fi

