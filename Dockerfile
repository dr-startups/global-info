# Next.js app image for the Digital Profile Audit module (Stage M3).
#
# Multi-stage: install deps -> build (prisma generate + next build) -> runtime.
# The runtime keeps node_modules so `prisma migrate deploy` (db:deploy) and the
# admin:create script can run inside the container. NO .env / secrets are baked
# into the image (see .dockerignore); configuration is injected at runtime.

# ---- base ------------------------------------------------------------------
FROM node:22-slim AS base
# openssl: required by Prisma engines. curl: container healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl \
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

# Built app + the bits needed to run, migrate and create an admin at runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS "http://localhost:3000/api/digital-profile/health" || exit 1

CMD ["npm", "run", "start"]
