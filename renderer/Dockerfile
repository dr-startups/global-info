# Digital Profile report renderer: python-pptx + headless LibreOffice.
FROM python:3.12-slim

# LibreOffice Impress (for PPTX->PDF) + fonts. Kept minimal to limit image size.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-impress \
        fonts-dejavu \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV DATA_ROOT=/data
EXPOSE 8080

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
