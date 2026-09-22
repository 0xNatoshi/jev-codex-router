#!/bin/sh
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
widget_dir="$repo_dir/apps/macos/RouterUsageWidget"
output_dir=${1:?usage: build-macos-widget.sh OUTPUT.appex [VERSION] [BUILD]}
marketing_version=${2:-0.1.0}
build_version=${3:-1}
widget_arch=${MODEL_ROUTER_WIDGET_ARCH:-$(uname -m)}
derived_data=$(mktemp -d "${TMPDIR:-/tmp}/model-router-widget.XXXXXX")

cleanup_widget_build() {
  rm -rf "$derived_data"
}
trap cleanup_widget_build EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "$widget_arch" in
  universal) architectures="arm64 x86_64" ;;
  arm64) architectures=arm64 ;;
  x86_64|x64) architectures=x86_64 ;;
  *) printf 'Unsupported macOS widget architecture: %s\n' "$widget_arch" >&2; exit 1 ;;
esac

xcodebuild \
  -project "$widget_dir/RouterUsageWidget.xcodeproj" \
  -scheme RouterUsageWidget \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -derivedDataPath "$derived_data" \
  build \
  CODE_SIGNING_ALLOWED=NO \
  "ARCHS=$architectures" \
  ONLY_ACTIVE_ARCH=NO \
  "MARKETING_VERSION=$marketing_version" \
  "CURRENT_PROJECT_VERSION=$build_version" 1>&2

built_extension="$derived_data/Build/Products/Release/RouterUsageWidget.appex"
built_binary="$built_extension/Contents/MacOS/RouterUsageWidget"
if [ ! -x "$built_binary" ]; then
  printf 'The macOS WidgetKit extension was not produced.\n' >&2
  exit 1
fi
configured_group=$(/usr/libexec/PlistBuddy -c 'Print :ModelRouterWidgetAppGroup' \
  "$built_extension/Contents/Info.plist")
if [ "$configured_group" != "group.io.github.codex-router" ]; then
  printf 'The macOS WidgetKit extension has an invalid App Group: %s\n' \
    "$configured_group" >&2
  exit 1
fi
configured_mode=$(/usr/libexec/PlistBuddy -c 'Print :ModelRouterWidgetStorageMode' \
  "$built_extension/Contents/Info.plist")
if [ "$configured_mode" != "app-group" ]; then
  printf 'The unsigned macOS WidgetKit extension has an invalid storage mode: %s\n' \
    "$configured_mode" >&2
  exit 1
fi

rm -rf "$output_dir"
mkdir -p "$(dirname -- "$output_dir")"
cp -R "$built_extension" "$output_dir"

trap - EXIT HUP INT TERM
cleanup_widget_build
printf '%s\n' "$output_dir"
