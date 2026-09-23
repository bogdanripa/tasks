# Built for linux/arm64 in CI (pironman is a Raspberry Pi).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
# curl: pironman's container healthcheck needs curl or wget.
RUN apk add --no-cache curl
WORKDIR /app
ENV NODE_ENV=production PORT=80
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://localhost:80/healthz || exit 1
CMD ["node", "server/dist/index.js"]
