#!/usr/bin/env sh
# Prints a TEST_DATABASE_URL for a local Postgres using credentials from pgpass (dev convenience only).
PGPW=$(grep '^127.0.0.1:5432:\*:postgres:' "${APPDATA:-$HOME}/postgresql/pgpass.conf" 2>/dev/null | cut -d: -f5- || grep '^127.0.0.1:5432:\*:postgres:' "$HOME/.pgpass" | cut -d: -f5-)
node -e 'console.log("postgres://postgres:"+encodeURIComponent(process.argv[1])+"@127.0.0.1:5432/"+(process.argv[2]||"zebscan_test"))' "$PGPW" "$1"
