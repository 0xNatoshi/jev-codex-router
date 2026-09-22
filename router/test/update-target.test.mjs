import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHECKOUT_ROOT,
  EMBEDDED_MONOREPO_ROOT,
  checkForUpdate,
  currentCheckoutInstaller,
  installationNeedsRefresh,
  localModificationsMessage,
  parseArguments,
  resolveCommand,
  trayRefreshRequired,
} from "../src/update.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("checkout updates preserve the codex target on every platform", () => {
  const windowsCodex = currentCheckoutInstaller("win32", "codex");
  assert.equal(windowsCodex.command, "powershell.exe");
  assert.deepEqual(windowsCodex.args.slice(-2), ["-Target", "codex"]);

  const posixCodex = currentCheckoutInstaller("darwin", "codex");
  assert.equal(
    posixCodex.command,
    EMBEDDED_MONOREPO_ROOT
      ? path.join(EMBEDDED_MONOREPO_ROOT, "install.sh")
      : path.join(repoRoot, "bin", "install"),
  );
  assert.deepEqual(posixCodex.args, []);
});

test("the embedded fork updates and installs through its owning monorepo", () => {
  assert.equal(EMBEDDED_MONOREPO_ROOT, path.dirname(repoRoot));
  assert.equal(CHECKOUT_ROOT, EMBEDDED_MONOREPO_ROOT);
  assert.equal(
    currentCheckoutInstaller("darwin", "codex").command,
    path.join(EMBEDDED_MONOREPO_ROOT, "install.sh"),
  );
  assert.equal(
    currentCheckoutInstaller("darwin", "codex", { posixScript: "enable" }).command,
    path.join(repoRoot, "bin", "enable"),
  );
});

test("a bare invocation updates and an explicit check stays read-only", () => {
  assert.equal(resolveCommand([]), resolveCommand(["update"]));
  assert.equal(resolveCommand(["check"]), checkForUpdate);
  assert.notEqual(resolveCommand(["check"]), resolveCommand(["update"]));
  assert.equal(resolveCommand(["nonsense"]), undefined);
});

test("a Homebrew install sends updates back to Homebrew", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "src", "update.mjs"), "check"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_ROUTER_PACKAGE_MANAGER: "homebrew",
        CODEX_ROUTER_SOURCE_ROOT: repoRoot,
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /brew upgrade codex-router/);
  assert.doesNotMatch(result.stderr, /not a Git checkout/);
});

test("an update reinstalls a revision pulled outside the updater", () => {
  assert.equal(installationNeedsRefresh(undefined, "new-revision"), true);
  assert.equal(
    installationNeedsRefresh({ current: { commit: "old-revision" } }, "new-revision"),
    true,
  );
  assert.equal(
    installationNeedsRefresh({ current: { commit: "new-revision" } }, "new-revision"),
    false,
  );
});

test("tray refresh is required when the checkout dist bundle exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-refresh-dist-"));
  try {
    mkdirSync(path.join(root, "dist", "Model Router.app"), { recursive: true });
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: root,
        registeredPath: "",
      }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tray refresh is required when setup installed the canonical home app bundle", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-refresh-home-"));
  try {
    mkdirSync(path.join(root, "home", "Applications", "Codex Router.app"), {
      recursive: true,
    });
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: path.join(root, "router"),
        registeredPath: "",
      }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tray refresh is required when only the legacy home app bundle exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-refresh-legacy-home-"));
  try {
    mkdirSync(path.join(root, "home", "Applications", "Model Router.app"), {
      recursive: true,
    });
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: path.join(root, "router"),
        registeredPath: "",
      }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tray refresh is required when only a registered bundle path exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-refresh-registered-"));
  try {
    const registered = path.join(root, "Codex Router.app");
    mkdirSync(registered, { recursive: true });
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: path.join(root, "router"),
        registeredPath: registered,
      }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tray refresh is skipped when no tray bundle exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-refresh-none-"));
  try {
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: path.join(root, "router"),
        registeredPath: "",
      }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tray refresh preserves an explicit macOS supervision disable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-refresh-disabled-"));
  try {
    mkdirSync(path.join(root, "home", "Applications", "Codex Router.app"), {
      recursive: true,
    });
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: path.join(root, "router"),
        registeredPath: path.join(root, "home", "Applications", "Codex Router.app"),
        supervisionPreference: { state: "disabled", enabled: false },
      }),
      false,
    );
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: path.join(root, "router"),
        registeredPath: path.join(root, "home", "Applications", "Codex Router.app"),
        supervisionPreference: { state: "invalid", enabled: null },
      }),
      false,
      "a damaged marker must fail closed instead of resurrecting the tray",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tray refresh is skipped on non-macOS platforms", () => {
  assert.equal(
    trayRefreshRequired({
      platform: "linux",
      home: os.homedir(),
      sourceRoot: path.resolve("."),
      registeredPath: path.resolve("."),
    }),
    false,
  );
});

test("--force is a flag on a command, never mistaken for one", () => {
  assert.equal(resolveCommand(["--force"]), resolveCommand(["update"]));
  assert.equal(resolveCommand(["check", "--force"]), checkForUpdate);

  assert.deepEqual(parseArguments([]), { command: resolveCommand(["update"]), force: false });
  assert.deepEqual(parseArguments(["--force"]), {
    command: resolveCommand(["update"]),
    force: true,
  });
  assert.deepEqual(parseArguments(["rollback", "--force"]), {
    command: resolveCommand(["rollback"]),
    force: true,
  });
  assert.equal(parseArguments(["nonsense"]).command, undefined);
});

test("a refused update names the files in the way and both ways forward", () => {
  const message = localModificationsMessage([" M src/router.mjs", " M bin/install"], "/tmp/checkout");
  assert.match(message, /2 tracked files/);
  // Whoever hits this has to be able to see what is holding the update, or
  // they are stuck on an old version with no way to work out why.
  assert.match(message, /src\/router\.mjs/);
  assert.match(message, /bin\/install/);
  assert.match(message, /git -C \/tmp\/checkout stash/);
  assert.match(message, /--force/);
});

test("a long list of local changes is previewed, not dumped", () => {
  const changes = Array.from({ length: 14 }, (_, index) => ` M src/file-${index}.mjs`);
  const message = localModificationsMessage(changes, "/tmp/checkout");
  assert.match(message, /14 tracked files/);
  assert.match(message, /src\/file-9\.mjs/);
  assert.equal(message.includes("src/file-10.mjs"), false);
  assert.match(message, /\.\.\.and 4 more/);
});

test("a single local change reads as one file, not one files", () => {
  assert.match(localModificationsMessage([" M src/router.mjs"]), /1 tracked file;/);
});

// The reviewer of #186 flagged that control.mjs's Windows apply branch was a
// hand-rolled PowerShell argument list with no test. It now reuses this helper,
// so the branch is covered here rather than being a second untested copy.
test("the enable path picks each platform's checkout entry point", () => {
  const windows = currentCheckoutInstaller("win32", "codex", { posixScript: "enable" });
  assert.equal(windows.command, "powershell.exe");
  assert.ok(windows.args.includes("-CheckoutInstall"));
  assert.ok(windows.args.some((argument) => argument.endsWith("install.ps1")));
  assert.deepEqual(windows.args.slice(-2), ["-Target", "codex"]);

  const posix = currentCheckoutInstaller("linux", "codex", { posixScript: "enable" });
  assert.match(posix.command, /bin[\\/]enable$/);
  assert.deepEqual(posix.args, []);
});

test("Windows runs one installer whichever entry point is asked for", () => {
  // codex-router.ps1 maps both `install` and `enable` onto
  // install.ps1 -CheckoutInstall, so posixScript must not leak into the
  // Windows argument list.
  assert.deepEqual(
    currentCheckoutInstaller("win32", "codex", { posixScript: "enable" }),
    currentCheckoutInstaller("win32", "codex"),
  );
});

test("the default entry point is still install", () => {
  assert.equal(
    currentCheckoutInstaller("darwin", "codex").command,
    EMBEDDED_MONOREPO_ROOT
      ? path.join(EMBEDDED_MONOREPO_ROOT, "install.sh")
      : path.join(repoRoot, "bin", "install"),
  );
});
