#!/usr/bin/env sh
# Point the public Vercel frontend at a public Zeb Scan API and redeploy production.
#   sh scripts/vercel-go-connected.sh https://<your-api-host>
# Only NEXT_PUBLIC (non-secret, browser-visible) values go to Vercel. Server secrets stay on the API host.
set -e
API="${1:?usage: vercel-go-connected.sh https://<public-api-url>}"
case "$API" in https://*) ;; *) echo "API URL must be https://" >&2; exit 64 ;; esac
API="${API%/}"
curl -fsS --max-time 20 "$API/healthz" >/dev/null || { echo "API $API/healthz is not reachable" >&2; exit 65; }
for k in NEXT_PUBLIC_ZEB_MODE NEXT_PUBLIC_API_BASE_URL; do vercel env rm "$k" production --yes >/dev/null 2>&1 || true; done
printf '%s' "connected" | vercel env add NEXT_PUBLIC_ZEB_MODE production
printf '%s' "$API" | vercel env add NEXT_PUBLIC_API_BASE_URL production
vercel deploy --prod --yes
