#!/usr/bin/env bash
# Builds a Foreseerr runtime directory: the Rust backend binary next to the
# files it reads from FORESEERR_APP_ROOT (see backend-rs/README.md):
#
#   <out>/foreseerr            (foreseerr.exe for Windows targets)
#   <out>/seerr-api.yml        the OpenAPI spec the request validator uses
#   <out>/dist/public/         the built frontend
#   <out>/committag.json       the commit shown in /status
#
# usage: scripts/build-runtime.sh <out-dir> [--target <rust-triple>] [--skip-web]
#
#   --target    build for another platform, e.g. aarch64-unknown-linux-gnu or
#               x86_64-pc-windows-gnu. A target other than the host's is
#               cross-compiled with cargo-zigbuild (cargo install
#               cargo-zigbuild, plus zig on PATH).
#   --skip-web  reuse dist/public from an earlier build of the same checkout.
#
# FORESEERR_BASE_PATH is passed to the frontend build (the Jellyfin plugin
# serves Foreseerr under a sub-path). COMMIT_TAG overrides the commit written
# to committag.json (default: the checkout's HEAD).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
out="$1"
shift
target=""
skip_web=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || usage
      target="$2"
      shift 2
      ;;
    --skip-web)
      skip_web=1
      shift
      ;;
    *) usage ;;
  esac
done

host="$(rustc -vV | sed -n 's/^host: //p')"
[[ -n "$target" ]] || target="$host"

if [[ $skip_web -eq 0 ]]; then
  (cd "$root" && bun run build:web)
fi
[[ -f "$root/dist/public/index.html" ]] || {
  echo "build-runtime: no frontend build in dist/public" >&2
  exit 1
}

cd "$root/backend-rs"
if [[ "$target" == "$host" ]]; then
  cargo build --release --locked
  bin_dir="target/release"
else
  cargo zigbuild --release --locked --target "$target"
  bin_dir="target/$target/release"
fi
exe=foreseerr
[[ "$target" == *windows* ]] && exe=foreseerr.exe

rm -rf "$out"
mkdir -p "$out/dist"
cp "$bin_dir/$exe" "$out/$exe"
cp "$root/seerr-api.yml" "$out/seerr-api.yml"
cp -R "$root/dist/public" "$out/dist/public"
commit="${COMMIT_TAG:-$(git -C "$root" rev-parse HEAD 2>/dev/null || echo local)}"
printf '{"commitTag": "%s"}\n' "$commit" > "$out/committag.json"
echo "build-runtime: $target runtime in $out"
