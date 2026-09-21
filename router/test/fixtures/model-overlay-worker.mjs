import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [mode, stateDir, tag, enteredPath, holdMs = "0"] = process.argv.slice(2);

// This file is a child-process fixture, not a test module. With no arguments it
// intentionally does nothing so Node's test discovery can safely ignore it.
if (mode) {
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  const statePath = path.join(stateDir, "selection.json");
  const { transactModelOverlayMutation } = await import(
    "../../src/model-overlay-publication.mjs"
  );
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const readSelection = () => {
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      return { selected: [] };
    }
  };
  const writeSelection = (selection) => writeFileSync(
    statePath,
    `${JSON.stringify(selection)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  try {
    let publicationAttempts = 0;
    await transactModelOverlayMutation({
      files: [statePath],
      mutate: async () => {
        if (enteredPath) writeFileSync(enteredPath, "entered\n");
        const selection = readSelection();
        // Read before the hold so an unlocked implementation deterministically
        // loses the second writer: both workers observe the same old state and
        // the first worker to write last erases the other selection.
        await sleep(Number(holdMs));
        selection.selected = [...new Set([...(selection.selected || []), tag])].sort();
        writeSelection(selection);
      },
      applyPublication: async () => {
        publicationAttempts += 1;
        if (mode === "failure" && publicationAttempts === 1) {
          throw new Error("deliberate publication failure");
        }
        return {};
      },
    });
    process.stdout.write("completed\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
