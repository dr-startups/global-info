# Next.js app image for the Digital Profile Audit module (Stage M3).
#
# Multi-stage: install deps -> build (prisma generate + next build) -> runtime.
# The runtime keeps node_modules so `prisma migrate deploy` (db:deploy) and the
# admin:create script can run inside the container. NO .env / secrets are baked
# into the image (see .dockerignore); configuration is injected at runtime.

# ---- base ------------------------------------------------------------------
FROM node:22-slim AS base
# openssl: required by Prisma engines. curl: container healthcheck.
# fonts-dejavu-core + fontconfig: needed by sharp/librsvg to rasterize text in
# the synthetic SERP snapshot SVGs (Stage S1); without fonts text would not render.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl \
       fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- build -----------------------------------------------------------------
FROM base AS build
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

# ---- runner ----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Stage S2 LIVE SERP — Playwright looks here for Chromium binaries.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Зависимости — отдельным слоем и раньше кода: они меняются вместе с
# package-lock, а не с каждой правкой в src.
COPY --from=build /app/node_modules ./node_modules

# Chromium + OS libs for LIVE SERP capture (manual API only; not used by PDF render).
# --with-deps installs apt packages required by headless Chrome on Debian slim.
#
# Стоит ДО копирования кода намеренно. Раньше этот шаг шёл последним, после
# всех COPY, и любая правка в `src` инвалидировала слои выше — значит, Chromium
# (~150 МБ) и apt-пакеты качались заново на каждой сборке. Из-за этого образ
# собирался очень долго при однострочном изменении кода.
#
# Слой зависит только от node_modules, поэтому переживает правки кода и
# пересобирается тогда, когда действительно меняется playwright.
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Built app + the bits needed to run, migrate and create an admin at runtime.
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
# Local golden-render fallback imports orion_golden_renderer from here.
COPY --from=build /app/renderer ./renderer

EXPOSE 3000

# Uses $PORT so it works locally (default 3000) and on Railway (assigned PORT).
# `next start` binds 0.0.0.0 and respects $PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT:-3000}/api/digital-profile/health" || exit 1

# Явно, хотя это и значение по умолчанию: остановка контейнера обязана быть
# сигналом, который процесс умеет обработать.
STOPSIGNAL SIGTERM

# Exec-форма и никакого `npm` в цепочке. `npm run` сигнал детям не передаёт —
# замер показал, что после SIGTERM в `npm run` внуки остаются живы: сервер Next
# не получал сигнала вовсе, контейнер добивался по таймауту, и Railway писал
# Crashed на каждом деплое. Теперь PID 1 — обычный Node-процесс, который сам
# получает сигнал и передаёт его дальше (scripts/start.mjs).
CMD ["node", "scripts/start.mjs"]
