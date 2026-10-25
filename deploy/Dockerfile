# Asistenta en modo servidor (Linux, amd64 o arm64): Telegram + modelo + navegador headless.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
# Chromium se instala fuera del HOME de root para que el usuario final pueda leerlo.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium
COPY . .
RUN npm run build
ENV PA_STATE_DIR=/data PA_DESKTOP=off PA_VAULT_BACKEND=portable PA_TIMEZONE=Europe/Madrid
ENV NODE_ENV=production
# El proceso corre sin privilegios; /data debe seguir siendo escribible.
RUN mkdir -p /data && chown -R node:node /app /data /ms-playwright
USER node
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node dist/cli.js status >/dev/null 2>&1 || exit 1
CMD ["node", "dist/cli.js", "serve"]
