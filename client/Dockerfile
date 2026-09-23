# Client image: builds the workspace, serves client/dist with nginx.
#
# The build context is the repository ROOT, not client/: the client imports
# `@collab/shared`, which only exists as a workspace, and `npm ci` needs the root
# manifest and lockfile. Dockerfile paths in compose are therefore written as
# `context: .` + `dockerfile: client/Dockerfile`.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY server/ ./server/
COPY client/ ./client/

# shared must be built before the client, which the script already encodes.
# Vite aliases `@collab/shared` to ../shared/src, so it compiles from source.
RUN npm run build

FROM nginx:1.27-alpine AS client

# Replaces the image's default conf.d/default.conf. Contains the /ws reverse proxy
# with the Upgrade headers; without it the browser's WebSocket never leaves nginx.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80
