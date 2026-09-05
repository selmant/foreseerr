#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
OUT="$ROOT/dist/Foreseerr"

dotnet_publish() {
  if command -v mise >/dev/null 2>&1 && [[ -f "$REPO/mise.toml" ]]; then
    (cd "$REPO" && mise exec -- dotnet publish "$ROOT/Foreseerr.Jellyfin.csproj" -c Release -o "$OUT")
  else
    dotnet publish "$ROOT/Foreseerr.Jellyfin.csproj" -c Release -o "$OUT"
  fi
}

dotnet_publish
mkdir -p "$OUT/sidecar"
if [[ -f "$REPO/dist/bin/foreseerr-linux-x64" ]]; then
  cp "$REPO/dist/bin/foreseerr-linux-x64" "$OUT/sidecar/"
fi
if [[ -f "$REPO/dist/bin/foreseerr-linux-arm64" ]]; then
  cp "$REPO/dist/bin/foreseerr-linux-arm64" "$OUT/sidecar/"
fi
if [[ -f "$REPO/dist/bin/foreseerr-windows-x64.exe" ]]; then
  cp "$REPO/dist/bin/foreseerr-windows-x64.exe" "$OUT/sidecar/"
fi
cat > "$OUT/meta.json" <<'EOF'
{
  "guid": "a7c3e2f1-9b4d-4e8a-8c1f-2b6d9e0f4a11",
  "name": "Foreseerr",
  "description": "Runs Foreseerr as a localhost sidecar and opens it from Jellyfin Web with SSO.",
  "overview": "Foreseerr sidecar plugin",
  "owner": "selmant",
  "category": "General",
  "targetAbi": "10.10.0.0",
  "timestamp": "2026-09-05T00:00:00Z",
  "version": "0.7.1.0",
  "status": "Active",
  "autoUpdate": false,
  "assemblies": []
}
EOF
(cd "$ROOT/dist" && zip -qr Foreseerr-0.7.1.0.zip Foreseerr)
echo "wrote $ROOT/dist/Foreseerr-0.7.1.0.zip"
