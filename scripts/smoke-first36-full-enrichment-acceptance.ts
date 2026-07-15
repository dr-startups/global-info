import { spawnSync } from "node:child_process";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
};

const env = { ...process.env, NETWORK_CALLS: "0" };
const run = (script: string) =>
  spawnSync("npm", ["run", script], { stdio: "inherit", env, shell: true }).status === 0;

check("p0 acceptance passes", run("smoke:first36-p0-acceptance"));
check("acceptance hardening passes", run("smoke:first36-acceptance-hardening"));
check("sidebar client policy passes", run("smoke:first36-sidebar-client-policy"));
check("cross-slide consistency passes", run("smoke:cross-slide-metric-consistency"));
check("client-copy completeness passes", run("smoke:client-copy-completeness"));

if (failures > 0) process.exitCode = 1;
console.log(failures ? `FAILED ${failures}` : "ALL PASS");
