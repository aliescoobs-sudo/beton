# BELGOBETON production image (R9). Provider-neutral: any host that runs containers. Multi-stage, non-root, no secret inside.
# Build:  docker build -t belgobeton:$(git rev-parse --short HEAD) .
# The Node and Alpine base is pinned by tag here; pin it by digest in your registry before a release (docker buildx imagetools inspect).
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# SIMULATION_ENABLED=false: the production build never carries the pilot simulation.
ENV SIMULATION_ENABLED=false NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
# pg_dump and psql for the backup and the restore test, age to seal the backup (the private key is never on this host).
RUN apk add --no-cache postgresql17-client age tini \
 && corepack enable \
 && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build --chown=app:app /app /app
USER app
EXPOSE 3000
# The process listens on all interfaces inside the container; the compose file keeps it off the host network.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health/live >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
