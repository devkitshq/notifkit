#!/usr/bin/env bash
#
# End-to-end push notification test.
#
# Drives the full pipeline: API → INBOUND → enricher → ENGINE → OUTBOUND →
# delivery → push transport. By default the delivery service uses the *console*
# push transport (set in apps/delivery/.env or PUSH_TRANSPORT=console), so you
# can SEE the rendered push printed with no Firebase / real device needed.
#
# To send a REAL push instead: set FIREBASE_SERVICE_ACCOUNT_JSON and
# PUSH_TRANSPORT=fcm in apps/delivery/.env, and use a real FCM device token
# below (DEVICE_TOKEN env var).
#
# Usage:
#   ./scripts/test-push.sh                 # console push (no setup)
#   DEVICE_TOKEN=<fcm-token> ./scripts/test-push.sh   # real token
#
set -euo pipefail

API="${API:-http://localhost:3000}"
PGURL="${DATABASE_URL:-postgres://platform:platform@localhost:5432/notifkit}"
DELIVERY_LOG="${DELIVERY_LOG:-/tmp/notifkit/delivery.log}"

# Unique per run so the engine's 3/hour throttle never blocks repeated tests.
STAMP="$(date +%s)"
USER_ID="test_push_${STAMP}"
DEVICE_TOKEN="${DEVICE_TOKEN:-demo-fcm-token-${STAMP}}"
NOTIF_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

say() { printf "\n\033[1;36m▶ %s\033[0m\n" "$1"; }
fail() { printf "\n\033[1;31m✗ %s\033[0m\n" "$1"; exit 1; }

# ── 0. Preflight: API must be up ─────────────────────────────────────────────
say "Checking API health ($API)"
if ! curl -sf "$API/health" >/dev/null; then
  fail "API not reachable. Start the stack first:  make build && make start"
fi
curl -s "$API/health"; echo

# ── 1. Create the recipient user ─────────────────────────────────────────────
say "Creating user $USER_ID"
curl -s -X POST "$API/v1/users" -H 'Content-Type: application/json' \
  -d "{\"id\":\"$USER_ID\",\"email\":\"$USER_ID@example.com\"}"; echo

# ── 2. Register an active push device token ──────────────────────────────────
# Delivery resolves push targets from the `devices` table, so seed one there.
say "Registering push device token: $DEVICE_TOKEN"
psql "$PGURL" -q -c \
  "INSERT INTO devices (user_id, device_token, platform, active)
   VALUES ('$USER_ID', '$DEVICE_TOKEN', 'fcm', TRUE)
   ON CONFLICT (device_token) DO UPDATE SET active = TRUE;"
echo "  ok"

# ── 3. Send a push notification through the pipeline ─────────────────────────
say "Publishing push notification (id=$NOTIF_ID)"
curl -s -X POST "$API/v1/notifications" -H 'Content-Type: application/json' -d "{
  \"id\": \"$NOTIF_ID\",
  \"recipientId\": \"$USER_ID\",
  \"channel\": \"push\",
  \"priority\": \"high\",
  \"payload\": { \"title\": \"Hello from Notifkit\", \"body\": \"Your test push is on its way\" }
}"; echo

# ── 4. Watch it come out the far end ─────────────────────────────────────────
say "Waiting for delivery (tailing $DELIVERY_LOG)…"
if [[ ! -f "$DELIVERY_LOG" ]]; then
  printf "\033[1;33m! %s\033[0m\n" "Delivery log not found at $DELIVERY_LOG."
  printf "  Watch the delivery service output directly, or set DELIVERY_LOG=<path>.\n"
  exit 0
fi

# Each worker stage adds a few seconds of poll latency, so allow ~45s total.
for _ in $(seq 1 45); do
  if grep -q "$USER_ID" "$DELIVERY_LOG" 2>/dev/null; then
    sleep 1  # let the full box finish printing
    break
  fi
  sleep 1
done

echo "── delivery output ──────────────────────────────────────────"
grep -A9 -e "PUSH NOTIFICATION" -e "$USER_ID" "$DELIVERY_LOG" | tail -25 || true
echo "─────────────────────────────────────────────────────────────"

if grep -q "no transport registered" "$DELIVERY_LOG"; then
  printf "\n\033[1;33m! Push was dropped — no push transport registered.\033[0m\n"
  printf "  Set PUSH_TRANSPORT=console in apps/delivery/.env and restart delivery.\n"
fi

say "Done. User=$USER_ID token=$DEVICE_TOKEN notif=$NOTIF_ID"
