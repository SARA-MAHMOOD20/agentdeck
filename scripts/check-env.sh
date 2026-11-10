#!/usr/bin/env bash
# Shows which keys in .env are filled in, grouped by phase.
# Never prints the values themselves.
set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"
[ -f "$ENV_FILE" ] || { echo "No .env file found at $ENV_FILE"; exit 1; }

get() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true; }

check() {
  local title="$1"; shift
  local filled=0 total=0
  echo; echo "== $title =="
  for key in "$@"; do
    total=$((total + 1))
    if [ -n "$(get "$key")" ]; then
      echo "  [x] $key"; filled=$((filled + 1))
    else
      echo "  [ ] $key"
    fi
  done
  echo "  -> $filled/$total filled"
}

check "Phase 1 (needed now)" \
  LLM_API_KEY LLM_BASE_URL LLM_MODEL_FAST LLM_MODEL_SMART LLM_RPM_LIMIT LLM_RPD_LIMIT \
  SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY \
  ENCRYPTION_KEY TIMEZONE DASHBOARD_ALLOWED_EMAIL DASHBOARD_URL API_URL

check "Phase 2 (Discord)" \
  DISCORD_BOT_TOKEN DISCORD_OWNER_ID DISCORD_GUILD_ID \
  DISCORD_CHANNEL_UNI_EMAIL DISCORD_CHANNEL_CALENDAR DISCORD_CHANNEL_WHATSAPP \
  DISCORD_CHANNEL_CHAT DISCORD_CHANNEL_ERRORS

check "Phase 3 (Google)" \
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI UNI_EMAIL_DOMAINS

# Basic sanity checks
echo
key="$(get ENCRYPTION_KEY)"
if [ -n "$key" ] && [ "$(printf '%s' "$key" | base64 -d 2>/dev/null | wc -c)" -ne 32 ]; then
  echo "WARNING: ENCRYPTION_KEY should be 32 bytes — generate with: openssl rand -base64 32"
fi
if grep -vE '^\s*#' "$ENV_FILE" | grep -qE '^[A-Z_]+ *= +|^[A-Z_]+ +='; then
  echo "WARNING: found a space next to '=' — remove it."
fi
