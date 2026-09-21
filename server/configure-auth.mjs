// Provision only Jev's local transport credential via the parent's supported
// credential transaction. No key is passed on argv, printed or checked in.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node server/configure-auth.mjs <codex-router checkout>");
const load = (name) => import(pathToFileURL(path.resolve(checkout, "src", name)).href);
const { genericProviderCredentialPath } = await load("provider-credentials.mjs");
const { runGenericCommand } = await load("providers.mjs");
const keyPath = genericProviderCredentialPath("jev");
const secret = existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : randomBytes(32).toString("hex");
if (!secret) throw new Error("Existing Jev credential is empty; repair it before continuing.");
await runGenericCommand(["credential", "jev", "set", "--json"], { prompt: () => secret });
