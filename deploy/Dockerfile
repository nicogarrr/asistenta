# Asistenta en modo servidor (Linux, amd64 o arm64): Telegram + modelo + navegador headless.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
RUN npx playwright install --with-deps chromium
COPY . .
RUN npm run build
ENV PA_STATE_DIR=/data PA_DESKTOP=off PA_VAULT_BACKEND=portable PA_TIMEZONE=Europe/Madrid
VOLUME /data
CMD ["node", "dist/cli.js", "serve"]
