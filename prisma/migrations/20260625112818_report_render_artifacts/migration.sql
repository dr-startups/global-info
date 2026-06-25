-- AlterTable
ALTER TABLE "dp_report_versions" ADD COLUMN     "pdfStorageKey" TEXT,
ADD COLUMN     "pptxStorageKey" TEXT,
ADD COLUMN     "renderedAt" TIMESTAMP(3);
