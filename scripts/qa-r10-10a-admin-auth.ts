/**
 * R10.10a — Admin auth QA entrypoint.
 */
import { writeAdminAuthQaArtifact } from "../src/modules/digital-profile/orion-golden/qa/r10-10a-admin-auth-qa";

const CASE_ID = process.env.CASE_ID?.trim() || "cmqzz1vbr00d2vdrsrjsgie2g";
const result = writeAdminAuthQaArtifact(process.cwd(), CASE_ID);
console.log(`[INFO] CASE_ID=${CASE_ID}`);
console.log(`[INFO] wrote ${result.outPath}`);
console.log(`[INFO] verdict=${result.verdict} passed=${result.passed}`);
console.log(`[INFO] issues=${result.issues.join(",") || "(none)"}`);
process.exit(result.passed ? 0 : 1);
