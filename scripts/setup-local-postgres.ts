/** One-off: recreate local Postgres container matching .env DATABASE_URL (password not logged). */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

function parseDatabaseUrl(): URL {
  for (const l of readFileSync(".env", "utf8").split(/\r?\n/)) {
    if (!l.startsWith("DATABASE_URL=")) continue;
    let v = l.slice("DATABASE_URL=".length).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return new URL(v);
  }
  throw new Error("DATABASE_URL not found in .env");
}

const u = parseDatabaseUrl();
const user = decodeURIComponent(u.username);
const pass = decodeURIComponent(u.password);
const db = u.pathname.replace(/^\//, "") || "global_info";
const port = u.port || "5432";

console.log(`Recreating dp-postgres for ${user}@${u.hostname}:${port}/${db} (password ${pass.length} chars)`);

try {
  execSync("docker stop dp-postgres", { stdio: "ignore" });
} catch {
  /* */
}
try {
  execSync("docker rm dp-postgres", { stdio: "ignore" });
} catch {
  /* */
}

const cmd = [
  "docker run -d --name dp-postgres",
  `-p ${port}:5432`,
  `-e POSTGRES_USER=${user}`,
  `-e POSTGRES_PASSWORD=${pass}`,
  `-e POSTGRES_DB=${db}`,
  "-v globalinfo_dp_pgdata:/var/lib/postgresql/data",
  "--health-cmd", `"pg_isready -U ${user} -d ${db}"`,
  "--health-interval 10s",
  "postgres:16-alpine",
].join(" ");

execSync(cmd, { stdio: "inherit" });
console.log("Postgres container started.");
