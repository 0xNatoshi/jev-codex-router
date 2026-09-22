#!/bin/sh
set -eu

# Install the complete Jev Codex Router stack from this monorepo. The embedded
# router is the only source checkout used by the service: no clone, submodule,
# or second source tree is required.
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname -- "$self")/$link ;;
  esac
done
repo_dir=$(CDPATH='' cd -P -- "$(dirname -- "$self")" && pwd -P)
router_dir=$repo_dir/router
router_cli=$router_dir/bin/codex-router
codex_home=${CODEX_HOME:-$HOME/.codex}
state_dir=${CODEX_ROUTER_STATE_DIR:-$codex_home/codex-router}

usage() {
  cat <<'EOF'
Usage: ./install.sh [--prepare-only]

Install Jev Codex Router from the embedded router fork.

  --prepare-only  Install the embedded router's dependencies without changing
                  Codex configuration, services, credentials, or local state.
  -h, --help      Show this help.

The full install preserves any configured router providers, adds or updates the
local Jev provider and jev/auto model, provisions its protected loopback
credential, enables native ChatGPT sharing, installs both launchd services, and
runs the end-to-end smoke test.
EOF
}

mode=install
case ${1:-} in
  "") ;;
  --prepare-only) mode=prepare ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { usage >&2; exit 2; }

[ -x "$router_cli" ] || {
  echo "Embedded router is missing at $router_cli." >&2
  exit 1
}

if [ "$mode" = prepare ]; then
  prepare_home=$(mktemp -d "${TMPDIR:-/tmp}/jev-codex-router-prepare.XXXXXX")
  cleanup_prepare_home() {
    [ -n "${prepare_home:-}" ] && [ -d "$prepare_home" ] &&
      rm -rf -- "$prepare_home"
  }
  trap cleanup_prepare_home EXIT HUP INT TERM
  CODEX_HOME=$prepare_home \
    CODEX_ROUTER_STATE_DIR=$prepare_home/codex-router \
    "$router_dir/bin/install" --prepare-only
  exit 0
fi

if [ -f "$state_dir/enabled-providers.json" ]; then
  "$router_dir/bin/install" --take-over-managed-router
else
  "$router_dir/install.sh" --no-provider --no-discovery --no-tray
fi

if "$router_cli" providers generic show jev --json >/dev/null 2>&1; then
  "$router_cli" providers generic edit jev \
    --name "Jev Router" \
    --base-url http://127.0.0.1:4319/v1 \
    --adapter openai-responses \
    --allow-private
else
  "$router_cli" providers generic add jev \
    --name "Jev Router" \
    --base-url http://127.0.0.1:4319/v1 \
    --adapter openai-responses \
    --allow-private
fi
"$router_cli" providers generic enable jev

node "$repo_dir/server/configure-model.mjs"
node "$repo_dir/server/configure-auth.mjs"
"$router_cli" chatgpt-session enable
"$router_cli" refresh-catalog
"$router_dir/bin/control" picker set jev/auto show

bash "$repo_dir/server/install-service.sh"
python3 "$repo_dir/server/smoke.py"

printf '\nJev Codex Router is installed from %s.\n' "$repo_dir"
printf 'Fully quit and reopen Codex, then select "Jev Codex Router".\n'
