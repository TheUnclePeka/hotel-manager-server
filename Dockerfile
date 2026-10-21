FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src ./src
COPY scripts/copy-migrations.mjs ./scripts/copy-migrations.mjs
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/app/data
WORKDIR /app
COPY LICENSE THIRD_PARTY_NOTICES.txt ./
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir /app/data && chown node:node /app/data
USER node
CMD ["node","dist/main.js"]
