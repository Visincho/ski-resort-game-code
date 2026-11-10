# Snowline: ski resort tycoon on real mountains (game client + universe server in one image).
# The server has zero npm dependencies, so there is no install step: just Node and the sources.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    CACHE_DIR=/cache

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node tools/warm-cache.mjs ./tools/warm-cache.mjs

# /data = universe, accounts and saves (back this up) · /cache = downloaded terrain tiles + OpenStreetMap
RUN mkdir -p /data /cache && chown node:node /data /cache
USER node
VOLUME ["/data", "/cache"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/universe/info').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# the server flushes the universe to disk on SIGTERM (docker stop)
CMD ["node", "server/server.js"]
