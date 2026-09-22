// Provision only Jev's local transport credential via the embedded router's
// credential transaction. No key is passed on argv, printed or checked in.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.argv.length > 2) {
  throw new Error("Usage: node server/configure-auth.mjs");
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkout = path.join(repo, "router");
if (!existsSync(path.join(checkout, "src", "providers.mjs"))) {
  throw new Error(`Embedded router source is missing at ${checkout}.`);
}
const load = (name) => import(pathToFileURL(path.resolve(checkout, "src", name)).href);
const { genericProviderCredentialPath } = await load("provider-credentials.mjs");
const { runGenericCommand } = await load("providers.mjs");
const keyPath = genericProviderCredentialPath("jev");
const secret = existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : randomBytes(32).toString("hex");
if (!secret) throw new Error("Existing Jev credential is empty; repair it before continuing.");
await runGenericCommand(["credential", "jev", "set", "--json"], { prompt: () => secret });
