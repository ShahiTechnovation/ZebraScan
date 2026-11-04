# Builds the API or the worker (ARG APP=api|worker) from the monorepo into a self-contained,
# non-root runtime image via `pnpm deploy`. No secrets are baked in.
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile --filter "@zeb/api..." --filter "@zeb/worker..."
ARG APP=api
RUN pnpm --filter @zeb/${APP} build && pnpm --filter @zeb/${APP} deploy --prod --legacy /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production MIGRATIONS_DIR=/srv/migrations
WORKDIR /srv
RUN useradd --system --uid 10001 zeb
COPY --from=build /out ./
COPY --from=build /repo/packages/db/migrations ./migrations
USER 10001
CMD ["node", "dist/main.js"]
