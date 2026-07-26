#!/usr/bin/env bash
# Entrypoint for the local dev app container (docker-compose.yml).
#
# Installs deps into the node_modules volume on first boot, keeps the Prisma
# client in sync with schema.prisma, applies migrations, then starts `next dev`.
set -euo pipefail

log() { echo "[dev-entrypoint] $*"; }

# --- dependencies ------------------------------------------------------------
if [ ! -x node_modules/.bin/next ]; then
  log "node_modules volume is empty — running npm ci (first boot, a few minutes)…"
  npm ci --no-audit --no-fund
else
  # Cheap drift check: reinstall when package.json is newer than the install marker.
  if [ package-lock.json -nt node_modules/.package-lock.json ]; then
    log "package-lock.json changed — running npm ci…"
    npm ci --no-audit --no-fund
  fi
fi

# --- prisma ------------------------------------------------------------------
log "prisma generate…"
npx --no-install prisma generate >/dev/null

log "waiting for postgres…"
for _ in $(seq 1 60); do
  if npx --no-install prisma db execute --schema prisma/schema.prisma --stdin <<<"SELECT 1;" >/dev/null 2>&1; then
    log "postgres is up."
    break
  fi
  sleep 2
done

log "prisma migrate deploy…"
npx --no-install prisma migrate deploy

# --- private storage ---------------------------------------------------------
mkdir -p "${DIGITAL_PROFILE_STORAGE_ROOT:-/app/storage/digital-profile}"

# Один образ, две роли: приложение и воркер шагов. Роль выбирается аргументом
# (compose передаёт его через `command`), а не отдельным образом.
if [ "${1:-app}" = "worker" ]; then
  log "starting step worker"
  exec npm run worker
fi

log "starting next dev on 0.0.0.0:3000"
exec npm run dev -- --hostname 0.0.0.0 --port 3000
