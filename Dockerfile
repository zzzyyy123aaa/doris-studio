FROM node:22.23.4-alpine3.23@sha256:546f76c5ef8161c2c37932978a63c89eb7ea61062537e5865361603d9d3af668 AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml ./
RUN npm install --global --ignore-scripts pnpm@11.25.0 \
    && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted

FROM base AS runtime
ENV NODE_ENV=production
ENV STUDIO_MONITORING_DIR=/app/monitoring-data
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.mjs ./
COPY server/ ./server/
COPY dist/ ./dist/
RUN install -d -o 1000 -g 1000 -m 0755 /app/monitoring-data
USER 1000:1000
CMD ["node", "server.mjs"]
