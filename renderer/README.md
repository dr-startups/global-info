# Digital Profile report renderer

Isolated Python microservice that renders a `report_json` into a **PPTX**
(python-pptx) and a **PDF** (headless LibreOffice).

It reads/writes the **shared private storage volume** (mounted at `/data`) using
the storage keys provided by the Node app, so generated files land in the same
private storage that the Node app serves via signed URLs. Nothing is exposed
publicly here.

## API

- `GET /health` → `{ "ok": true }`
- `POST /render`
  ```json
  {
    "reportJson": { },
    "pptxKey": "<caseId>/reports/v1.pptx",
    "pdfKey":  "<caseId>/reports/v1.pdf"
  }
  ```
  → `{ "pptx": { "storageKey", "sizeBytes", "sha256" }, "pdf": { } }`

## Run (Docker)

From the repo root:

```bash
docker compose up -d --build renderer
curl http://localhost:8080/health
```

The `docker-compose.yml` mounts `./storage` to `/data` and publishes port 8080.

## Custom template

Drop a `renderer/template.pptx` to control master slides / branding. When
present it is used as the base presentation; otherwise a clean default deck is
generated. Dynamic (person-specific) pages render first, then static commercial
pages. A faint "DRAFT" watermark is stamped while the report is not final.

## Local dev (without Docker)

Requires LibreOffice installed locally (`soffice` on PATH):

```bash
pip install -r requirements.txt
DATA_ROOT=../storage/digital-profile uvicorn app:app --port 8080
```
