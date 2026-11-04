# Watch-only Zcash wallet server for Zeb Scan (zkool2 `zkool_graphql`, NU7 + Ironwood).
# Pinned to the upstream image published by the zkool2 release workflow (v6.36.0, 2026-11-02).
# We do not rebuild zkool: this layer only adds a start script that binds Render's $PORT and
# REQUIRES ES256 JWT auth (never --allow-unauthenticated on a reachable interface).
FROM docker.io/hhanh00/zkool-graphql:6.36.0@sha256:222039f67c99a1910c84bb121b1350ffca9954d75f1b5ab87a3840f99547f902
COPY start.sh /zebscan-start.sh
ENTRYPOINT ["/bin/sh", "/zebscan-start.sh"]
