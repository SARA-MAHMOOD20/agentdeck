#!/usr/bin/env bash
# Applies pending SQL migrations in supabase/migrations to the Supabase project.
# Uses SUPABASE_DB_URL from .env (Session pooler URI). The URL is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_URL="$(grep -E '^SUPABASE_DB_URL=' .env | head -n1 | cut -d= -f2-)"
if [ -z "$DB_URL" ]; then
  echo "SUPABASE_DB_URL is empty in .env."
  echo "Supabase dashboard → Connect → Session pooler → copy the URI, replace [YOUR-PASSWORD]."
  exit 1
fi

pnpm dlx supabase@latest db push --db-url "$DB_URL" --include-all --yes
