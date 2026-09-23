# Server image: builds the workspace, ships only what the server runs.
#
# The build context is the repository ROOT, not server/. npm workspaces need the
# root manifest, the lockfile, and every workspace's package.json to run `npm ci`,
# and the server resolves `@collab/shared` through the workspace symlink.

FROM node:22-alpine AS build
WORKDIR /app

# Manifests first so `npm ci` is cached independently of source edits.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

# tsconfig.base.json is extended by every package's tsconfig.
COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY server/ ./server/
COPY client/ ./client/

# The existing build script, unchanged: shared -> server -> client, in that order.
# The client build is not needed by this image; it runs because the brief is to
# reuse `npm run build` rather than fork the build flow.
RUN npm run build

FROM node:22-alpine AS server
ENV NODE_ENV=production
WORKDIR /app

# The SQLite file lives on the `collab-data` volume, mounted at /app/data.
#
# The directory must exist in the image and already belong to node, and both
# have to happen before USER node takes effect: /app itself is root-owned, so a
# container running as uid 1000 cannot create anything inside it. If the
# directory were left to the volume mount, Docker would create the mountpoint as
# root and the server would come up unable to open its database.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

# node_modules carries the workspace symlink node_modules/@collab/shared -> ../shared,
# so /app/shared/dist has to land at the same relative path it had in the builder.
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist

# Listening port only; compose does not publish it to the host.
EXPOSE 3000

# server.ts reads PORT (default 3000) and binds all interfaces.
CMD ["node", "server/dist/server.js"]
