FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter "@zeb/web..."
# Public build-time configuration only (never secrets).
ARG NEXT_PUBLIC_ZEB_MODE=connected
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_ZEB_MODE=$NEXT_PUBLIC_ZEB_MODE NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN pnpm --filter @zeb/web build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /srv
RUN corepack enable && useradd --system --uid 10001 zeb
COPY --from=build /repo /srv
USER 10001
WORKDIR /srv/apps/web
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
