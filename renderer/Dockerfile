# Digital Profile report renderer: python-pptx + headless LibreOffice.
FROM python:3.12-slim

# LibreOffice Impress (for PPTX->PDF) + fonts + curl (for the healthcheck).
# Kept minimal to limit image size.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-impress \
        fonts-dejavu \
        fonts-liberation \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV DATA_ROOT=/data
ENV PYTHONUNBUFFERED=1
EXPOSE 8080

# Liveness/readiness: reports unhealthy if LibreOffice is missing. Uses $PORT so
# it works both locally (default 8080) and on Railway (assigned PORT).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT:-8080}/health" | grep -q '"ok":true' || exit 1

# Shell form so env expands. Default host :: (IPv6) for Railway private
# networking; override RENDERER_HOST=0.0.0.0 on IPv4-only networks (Docker bridge).
CMD uvicorn app:app --host ${RENDERER_HOST:-::} --port ${PORT:-8080}
