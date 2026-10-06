# BeePM registry API. Build from the repository root:
#   docker build -f server/Dockerfile .
# Only the server and core workspaces are installed (no Electron, no app dependencies).
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# The other workspaces' package.json files aren't needed: npm ci --workspace only installs
# what the server (and core, which it depends on) need
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace @beepm/server --no-audit --no-fund && npm cache clean --force

COPY core/src core/src
COPY server/src server/src
COPY server/scripts server/scripts

USER node
EXPOSE 8080
CMD ["node", "server/src/index.js"]
