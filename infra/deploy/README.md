# Production deployment requirements

Separate stacks, databases, secrets, signers and dashboards per environment (`testnet`, `mainnet-readonly`, `mainnet-enabled`). Never share a database or KEK across environments.

1. **Images**: `infra/docker/node.Dockerfile` (`APP=api|worker`), `web.Dockerfile`, `zcash-gateway.Dockerfile`. Run as non-root; read-only root FS; secrets via the platform secret manager (files/env injected at runtime), never baked in.
2. **Network**: public ingress → web + API only. `/api/v1/internal/*` and `/api/v1/ops/*` reachable only from the internal network / operator VPN; internal ingress terminates **mTLS** and the API additionally verifies `X-Zeb-Signature`. Gateway reachable only from API/worker over mTLS. DB with TLS (`sslmode=verify-full`), least-privilege roles (app role without DDL; migrator role separate).
3. **Order**: `node dist/migrate.js` (migrator role) → API → worker(s) (`WORKER_HEALTH_PORT` for liveness) → web.
4. **Gate**: `pnpm verify:prod-config` must exit 0 in the target environment before traffic is admitted; `pnpm verify:external` evidence refreshed and attached to the change.
5. **Observability**: JSON logs (redacted) to the log pipeline; alert on urgent `exceptions`, dead `jobs`, `/readyz` feature closures, reconciliation failures. Do not ship VPAs/addresses/keys to third-party telemetry.
6. **Backups**: PostgreSQL PITR; gateway wallet DB + event log on encrypted volumes with snapshot schedule; quarterly restore drill (see `docs/RUNBOOKS.md`).
