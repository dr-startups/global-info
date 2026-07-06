import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const root = join(process.cwd(), "src/modules/digital-profile/orion-client-storyboard");
  const renderer = join(process.cwd(), "renderer/orion_visual_composer.py");
  const appPy = readFileSync(join(process.cwd(), "renderer/app.py"), "utf-8");

  check("orion-client-storyboard module", existsSync(root));
  check("types.ts", existsSync(join(root, "types.ts")));
  check("schema.ts", existsSync(join(root, "schema.ts")));
  check("storyboard-composer.ts", existsSync(join(root, "storyboard-composer.ts")));
  check("gpt-storyboard-analyzer.ts", existsSync(join(root, "gpt-storyboard-analyzer.ts")));
  check("orion_visual_composer.py", existsSync(renderer));
  check("render endpoint", appPy.includes("/orion/render-client-storyboard"));
  check("qa script", existsSync(join(process.cwd(), "scripts/qa-r9-9-orion-client-storyboard.ts")));
  check("render fallback script", existsSync(join(process.cwd(), "scripts/render-orion-storyboard-artifacts.py")));

  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as {
    scripts?: Record<string, string>;
  };
  check("npm smoke script", Boolean(pkg.scripts?.["smoke:orion-client-storyboard-r99"]));
  check("npm qa script", Boolean(pkg.scripts?.["qa:r9-9-orion-client-storyboard"]));

  console.log(`\nVERDICT: ${failures ? "BLOCKED" : "PASS"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
