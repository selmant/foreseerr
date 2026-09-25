#!/usr/bin/env bash
set -euo pipefail
PLUGIN_ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/.." && pwd)"
PLUGIN_ABI="${1:-10.11}"
if [[ "$PLUGIN_ABI" != "10.11" && "$PLUGIN_ABI" != "12" ]]; then
  echo 'usage: plugin/build.sh [10.11|12] [linux-x64 linux-arm64 windows-x64]' >&2
  exit 1
fi
if (( $# > 0 )); then shift; fi
if (( $# == 0 )); then set -- linux-x64 linux-arm64 windows-x64; fi
for target in "$@"; do
  case "$target" in
    linux-x64|linux-arm64) binary="foreseerr-$target" ;;
    windows-x64) binary="foreseerr-$target.exe" ;;
    *) echo "Unsupported sidecar target: $target" >&2; exit 1 ;;
  esac
  test -s "$REPO_ROOT/dist/bin/$binary" || { echo "Missing $binary; run bun run compile:plugin first" >&2; exit 1; }
done
dotnet_cmd() {
  if command -v mise >/dev/null 2>&1; then
    local root
    root="$(cd "$REPO_ROOT" && mise where dotnet)"
    DOTNET_ROOT="$root" "$root/dotnet" "$@"
  else
    dotnet "$@"
  fi
}
PROJECT="$PLUGIN_ROOT/Foreseerr.Jellyfin.csproj"
PLUGIN_OUT="$PLUGIN_ROOT/dist/jellyfin-$PLUGIN_ABI/Foreseerr"
rm -rf "$PLUGIN_OUT"
mkdir -p "$PLUGIN_OUT/sidecar"
dotnet_cmd publish "$PROJECT" -c Release -p:JellyfinTarget="$PLUGIN_ABI" -o "$PLUGIN_OUT"
for target in "$@"; do
  binary="foreseerr-$target"
  if [[ "$target" == "windows-x64" ]]; then binary="$binary.exe"; fi
  cp "$REPO_ROOT/dist/bin/$binary" "$PLUGIN_OUT/sidecar/"
done
# Build.props owns the per-ABI plugin version and targetAbi.
PLUGIN_PROPERTIES="$(dotnet_cmd msbuild "$PROJECT" -p:JellyfinTarget="$PLUGIN_ABI" \
  -getProperty:AssemblyVersion -getProperty:TargetAbi)"
bun "$REPO_ROOT/scripts/pack-plugin.mjs" "$PLUGIN_ABI" "$PLUGIN_OUT" "$PLUGIN_PROPERTIES"
