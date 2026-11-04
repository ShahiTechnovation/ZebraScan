# ADR-0001 — Monorepo, Fastify, PostgreSQL as the authority
Status: accepted (2026-11-04)

pnpm workspaces keep web, API, worker and shared packages typed end to end. Fastify + Zod give one schema per route; the route table also generates OpenAPI and the browser client, so they cannot drift. PostgreSQL (transactions, row locks, `FOR UPDATE SKIP LOCKED` job leases, deferred constraint triggers) is the single authority for money state; no Redis/BullMQ is required for correctness, so none was added. Shared domain commands live in `packages/core` so API and worker execute identical code.
