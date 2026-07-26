# Digital Profile report renderer: python-pptx + headless LibreOffice.
#
# Build context is the REPO ROOT (so the same Dockerfile works on Railway, where
# the context is always the repo root, and in docker-compose which sets
# context: . + dockerfile: renderer/Dockerfile). All COPY paths are therefore
# prefixed with renderer/.
FROM python:3.12-slim

# LibreOffice Impress/Writer + fonts + curl (for the healthcheck).
# Kept minimal to limit image size.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-impress \
        libreoffice-writer \
        fonts-dejavu \
        fonts-liberation \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY renderer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY renderer/ .

ENV DATA_ROOT=/data
ENV PYTHONUNBUFFERED=1
EXPOSE 8080

# Liveness/readiness: reports unhealthy if LibreOffice is missing. Uses $PORT so
# it works both locally (default 8080) and on Railway (assigned PORT).
#
# Адрес 127.0.0.1, а не localhost: последний может разрешиться в ::1, и проверка
# начнёт зависеть от того, какая петля отвечает. Слушатель двустековый
# (см. serve.py), поэтому годятся оба, но выбирать наугад незачем.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/health" | grep -q '"ok":true' || exit 1

# Один слушатель на оба протокола: приватная сеть Railway работает по IPv6, а
# проверки работоспособности и мостовая сеть Docker — по IPv4. Прежняя строка
# `uvicorn --host ::` поднимала слушатель ТОЛЬКО IPv6 (asyncio выставляет
# IPV6_V6ONLY), из-за чего проверка образа не проходила никогда.
CMD ["python", "serve.py"]
