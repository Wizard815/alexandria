#!/usr/bin/env bash
# Pack the Linux desktop app: the release binary, an icon, a .desktop launcher and a tiny
# install.sh that copies them under ~/.local (no root needed).
#
#   scripts/package-linux.sh [outdir]
#
# Run `cd desktop && npx tauri build --no-bundle` first. Output:
#   <outdir>/Alexandria-<RELEASE_NAME>-linux-x86_64.tar.gz   (outdir defaults to dist/)
set -euo pipefail
cd "$(dirname "$0")/.."

release="$(tr -d '[:space:]' < RELEASE_NAME)"
out="${1:-dist}"
bin="desktop/src-tauri/target/release/alexandria-desktop"
[ -x "$bin" ] || { echo "missing $bin: run 'cd desktop && npx tauri build --no-bundle' first" >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
dir="$stage/Alexandria-$release-linux-x86_64"
mkdir -p "$dir" "$out"
install -m 755 "$bin" "$dir/alexandria"
install -m 644 desktop/src-tauri/icons/128x128@2x.png "$dir/alexandria.png"

cat > "$dir/alexandria.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Alexandria
Comment=Alexandria campaign app
Exec=ALEXANDRIA_BIN
Icon=ALEXANDRIA_ICON
Terminal=false
Categories=Game;
StartupWMClass=alexandria-desktop
EOF

cat > "$dir/install.sh" <<'EOF'
#!/bin/sh
# Installs Alexandria for the current user: ~/.local/bin, ~/.local/share/applications and icons.
# Remove it with: rm ~/.local/bin/alexandria ~/.local/share/applications/alexandria.desktop ~/.local/share/icons/alexandria.png
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="$HOME/.local/bin"; apps="$HOME/.local/share/applications"; icons="$HOME/.local/share/icons"
mkdir -p "$bin" "$apps" "$icons"
install -m 755 "$here/alexandria" "$bin/alexandria"
install -m 644 "$here/alexandria.png" "$icons/alexandria.png"
sed -e "s#ALEXANDRIA_BIN#$bin/alexandria#" -e "s#ALEXANDRIA_ICON#$icons/alexandria.png#" "$here/alexandria.desktop" > "$apps/alexandria.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" >/dev/null 2>&1 || true
echo "Installed. Start Alexandria from your applications menu, or run: $bin/alexandria"
echo "It needs WebKitGTK: on Ubuntu/Debian run: sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0"
EOF
chmod +x "$dir/install.sh"

tar -C "$stage" -czf "$out/Alexandria-$release-linux-x86_64.tar.gz" "Alexandria-$release-linux-x86_64"
echo "wrote $out/Alexandria-$release-linux-x86_64.tar.gz"
