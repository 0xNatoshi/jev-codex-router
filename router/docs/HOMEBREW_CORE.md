# Homebrew core submission

Codex Router is eligible to be proposed to `Homebrew/homebrew-core`. There is
no application form: the submission is a pull request adding
`Formula/c/codex-router.rb` to `homebrew-core`. It has **not** been accepted
yet, so the public install remains the explicit tap until that pull request is
merged.

As checked on August 28, 2026, the repository is more than 30 days old and its
stars and forks exceed Homebrew's self-submission notability threshold. v0.5.0
is stable but predates the Homebrew desktop-build guard; submit v0.5.1 or newer.
Recheck those facts immediately before opening the pull request instead of
treating this note as permanent approval.

The formula is intentionally CLI-first. It installs the router, provider
setup, background service, and browser panel; it does not build or download the
Electron Control Center, native tray/menu-bar app, or macOS desktop widget.
Those remain part of the recommended source installer. Keeping desktop builds
out of Homebrew setup avoids mutating the keg or downloading application code
at runtime, and keeps the formula aligned with `homebrew/core` rather than a
native-app cask.

Do not submit the formula while its source URL still points at v0.5.0. Publish
v0.5.1 from the commit containing this change, then let the release workflow
regenerate the formula URL and checksum before copying it into `homebrew-core`.

## Before submitting

- Confirm the upstream repository is still at least 30 days old.
- Publish the next release containing the Homebrew desktop-build guard and
  identify it explicitly as stable. A beta or release candidate is not
  eligible. The tag, `package.json` version, source archive name, formula
  version, and release URL must agree.
- Confirm the repository still meets Homebrew's self-submission notability
  threshold: 90 forks, 90 watchers, or 225 stars.
- Confirm the release archive is immutable and that the formula contains its
  SHA-256 checksum.
- Run the formula audit on the generated formula:

  ```sh
  packaging/homebrew/check-core-readiness.sh
  ```

- After the release workflow regenerates the checked-in formula, run a clean
  source installation on both macOS and Linux. The CI workflow's manual
  `workflow_dispatch` path runs:

  ```sh
  packaging/homebrew/check-core-readiness.sh --install
  ```

  The install check intentionally refuses to replace an existing
  `codex-router` formula.
- Verify the stable release through the normal release workflow. It must
  regenerate `Formula/codex-router.rb` without drift.

## Prepare the Homebrew contribution

Fork `Homebrew/homebrew-core`, then create a branch from its current default
branch:

```sh
brew update
brew tap --force homebrew/core
cd "$(brew --repository homebrew/core)"
git switch -c codex-router-new-formula origin/HEAD
git remote add YOUR_USERNAME https://github.com/YOUR_USERNAME/homebrew-core.git
```

Copy the stable generated formula from this repository to
`Formula/c/codex-router.rb`. Do not copy a beta formula or add a `bottle` block;
Homebrew creates the bottle block after its builders pass.

Run Homebrew's submission checks from the `homebrew-core` checkout:

```sh
HOMEBREW_NO_INSTALL_FROM_API=1 brew install --build-from-source codex-router
brew test codex-router
brew audit --strict --new --online codex-router
brew style --fix --formula codex-router
brew lgtm --online
```

Commit the single formula and push it to the fork:

```sh
git add Formula/c/codex-router.rb
git commit -m "codex-router VERSION (new formula)"
git push -u YOUR_USERNAME codex-router-new-formula
```

Open a pull request from that branch to `Homebrew/homebrew-core:main` and
complete its checklist. If AI assisted with the formula or pull-request text,
disclose that assistance in the initial pull-request description, review all
generated work before requesting review, and answer maintainer feedback
yourself as required by Homebrew's contribution policy.
