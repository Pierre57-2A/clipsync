# Image de production du serveur relais ClipSync.
FROM node:22-alpine

WORKDIR /app

# Dépendances (couche cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Code + PWA
COPY src ./src
COPY public ./public

ENV PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null 2>&1 || exit 1

CMD ["node", "src/index.js"]
