-- AlterTable: add FK caseId → dp_cases for Arsenkin stage ledger (P0.5 acceptance repair)
ALTER TABLE "dp_orion_arsenkin_stage_runs"
  ADD CONSTRAINT "dp_orion_arsenkin_stage_runs_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
