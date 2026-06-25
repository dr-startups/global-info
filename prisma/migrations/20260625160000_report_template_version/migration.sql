-- Stage K1: persist which template rendered a report version + renderer warnings.
ALTER TABLE "dp_report_versions"
  ADD COLUMN "templateVersion" TEXT,
  ADD COLUMN "renderWarnings" JSONB;
