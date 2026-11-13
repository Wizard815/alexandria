#!/usr/bin/env bash
# Download a consistent backup of Alexandria: one .tar.gz with the database
# (every world) and the data folders (audio recordings and so on).
# Usage: ALX_URL=https://alexandria.example.com ALX_ADMIN_KEY=alx_adm_... ./deploy/backup.sh [dir]
# Set ALX_DB_ONLY=1 for just the database file (no audio).
set -euo pipefail
dir="${1:-./backups}"
mkdir -p "$dir"
if [ "${ALX_DB_ONLY:-}" = "1" ]; then
  ext="db"; query="?db=1"
else
  ext="tar.gz"; query=""
fi
out="$dir/alexandria-$(date +%Y-%m-%d-%H%M).$ext"
curl -fsS -H "Authorization: Bearer ${ALX_ADMIN_KEY:?set ALX_ADMIN_KEY}" "${ALX_URL:?set ALX_URL}/api/admin/backup${query}" -o "$out"
# keep the last 14
ls -1t "$dir"/alexandria-*."$ext" | tail -n +15 | xargs -r rm --
echo "saved $out"
