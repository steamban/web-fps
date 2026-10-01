# Production image: the client is built here and the server serves it, so the whole game
# is one container and one published port. `Dockerfile.dev` is the live-reload counterpart.

FROM node:26-alpine AS build

WORKDIR /app

# Manifests first so `npm ci` is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci

COPY . .
RUN npm run build --workspace @web-fps/client

# The runtime needs no bundler, no Three.js and no type definitions, so the dependency
# tree is installed again without them rather than copied out of the build stage.
FROM node:26-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --workspace @web-fps/server --include-workspace-root

COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src
COPY --from=build /app/packages/client/dist packages/client/dist

EXPOSE 8080

# Not `npm start`: npm would sit between the signal and the server, and the shutdown
# handler in index.ts is what closes the sockets before the process exits.
CMD ["npx", "tsx", "packages/server/src/index.ts"]
