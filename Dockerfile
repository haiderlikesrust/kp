# syntax=docker/dockerfile:1
# One server: the site, the API and the game workers. Dokploy runs it as a Swarm
# service and updates it start-first, so the new version takes over before the
# old one stops. See docs/DOKPLOY.md.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
RUN npm run build && mv dist web-build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json .npmrc ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node deploy ./deploy
COPY --from=build --chown=node:node /app/web-build ./web-build
# dist is filled at start by deploy/publish-web.mjs. A Dokploy volume on
# dist/assets keeps earlier builds' files for pages opened before an update.
RUN mkdir -p dist/assets && chown -R node:node dist
USER node
EXPOSE 3000
# Healthy includes standby: during an update the new server waits for the old one.
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["sh", "deploy/start.sh"]
