import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const directories = [root, path.join(root, "src"), path.join(root, "test")];

for (const directory of directories) {
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry);
    if (statSync(target).isFile() && target.endsWith(".mjs")) {
      execFileSync(process.execPath, ["--check", target], { stdio: "inherit" });
    }
  }
}

execFileSync(process.execPath, [path.join(root, "scripts", "check-v2-agent-applications.mjs")], {
  stdio: "inherit",
});

console.log("syntax checks passed");
