FROM node:22-alpine

WORKDIR /app
RUN chown node:node /app
# Before `npm ci`, so node_modules is owned by `node` (vitest writes its cache there).
USER node

COPY --chown=node:node package.json package-lock.json ./
# devDependencies stay: tsx runs the app and vitest runs the tests in this image.
RUN npm ci

COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node test ./test
COPY --chown=node:node tsconfig.json vitest.config.ts ./

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# TypeScript runs through tsx, not dist/: tsc emits migrate.js under dist/src/db,
# where its '../../migrations/' lookup resolves to the wrong place.
# `exec` replaces the shell so SIGTERM reaches the server (`npm start` would not
# forward it and graceful shutdown would never run).
CMD ["sh", "-c", "node_modules/.bin/tsx src/db/migrate.ts && exec node_modules/.bin/tsx src/server.ts"]
