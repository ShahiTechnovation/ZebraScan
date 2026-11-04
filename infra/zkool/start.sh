#!/bin/sh
# Zeb Scan zkool_graphql launcher. Fails closed on missing/unsafe config.
#   ZKOOL_NETWORK         testnet | mainnet            (required; picks coin type for a NEW db)
#   ZKOOL_LWD_URL         lightwalletd gRPC URL         (required; testnet: https://testnet.zec.rocks:443)
#   ZKOOL_JWT_PUBLIC_KEY  ES256 public key PEM (SPKI)   (required; private half stays with the Zeb Scan worker)
#   ZKOOL_DB_DIR          default /var/zkool (falls back to /tmp when not writable)
#   PORT                  injected by Render (default 10000)
set -eu

case "${ZKOOL_NETWORK:-}" in
  testnet) COIN=1 ;;
  mainnet) COIN=0 ;;
  *) echo "FATAL: ZKOOL_NETWORK must be testnet or mainnet" >&2; exit 64 ;;
esac
[ -n "${ZKOOL_LWD_URL:-}" ] || { echo "FATAL: ZKOOL_LWD_URL is required" >&2; exit 64; }
if [ "$ZKOOL_NETWORK" = "mainnet" ] && echo "$ZKOOL_LWD_URL" | grep -qi testnet; then
  echo "FATAL: mainnet service pointed at a testnet lightwalletd" >&2; exit 64
fi
if [ "$ZKOOL_NETWORK" = "testnet" ] && ! echo "$ZKOOL_LWD_URL" | grep -qi testnet; then
  echo "FATAL: testnet service pointed at a non-testnet lightwalletd" >&2; exit 64
fi
[ -n "${ZKOOL_JWT_PUBLIC_KEY:-}" ] || { echo "FATAL: ZKOOL_JWT_PUBLIC_KEY is required (JWT auth is mandatory)" >&2; exit 64; }

DB_DIR="${ZKOOL_DB_DIR:-/var/zkool}"
mkdir -p "$DB_DIR" 2>/dev/null || DB_DIR=/tmp/zkool
mkdir -p "$DB_DIR"
KEY_FILE=/tmp/zkool-jwt.pub.pem
printf '%s\n' "$ZKOOL_JWT_PUBLIC_KEY" | sed 's/\\n/\n/g' > "$KEY_FILE"

# Database file name carries the network so a testnet db can never be opened as mainnet by accident.
DB="$DB_DIR/zebscan-$ZKOOL_NETWORK.db"
# Mainnet: the wallet db MUST be encrypted. Testnet (TAZ, no value) may run unencrypted.
if [ -n "${ZKOOL_DB_PASSWORD:-}" ]; then
  PW_FILE=/tmp/zkool-db.pw; umask 077; printf '%s' "$ZKOOL_DB_PASSWORD" > "$PW_FILE"
  set -- --db-password-file "$PW_FILE"
elif [ "$ZKOOL_NETWORK" = "mainnet" ]; then
  echo "FATAL: mainnet requires ZKOOL_DB_PASSWORD (encrypted wallet database)" >&2; exit 64
else
  set -- --allow-unencrypted-database
fi
echo "zebscan-zkool: network=$ZKOOL_NETWORK coin=$COIN db=$DB lwd=$ZKOOL_LWD_URL port=${PORT:-10000}"
exec /bin/zkool_graphql \
  --db-path "$DB" \
  --coin "$COIN" \
  --lwd-url "$ZKOOL_LWD_URL" \
  --port "${PORT:-10000}" \
  --bind-address 0.0.0.0 \
  --jwt-public-key-file "$KEY_FILE" \
  "$@"
