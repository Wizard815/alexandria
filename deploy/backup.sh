#!/usr/bin/env bash
# Download a consistent backup of Alexandria's database (every world).
# Usage: ALX_URL=https://alexandria.example.com ALX_ADMIN_KEY=alx_adm_... ./deploy/backup.sh [dir]
set -euo pipefail
dir="${1:-./backups}"
mkdir -p "$dir"
out="$dir/alexandria-$(date +%Y-%m-%d-%H%M).db"
curl -fsS -H "Authorization: Bearer ${ALX_ADMIN_KEY:?set ALX_ADMIN_KEY}" "${ALX_URL:?set ALX_URL}/api/admin/backup" -o "$out"
# keep the last 14
ls -1t "$dir"/alexandria-*.db | tail -n +15 | xargs -r rm --
echo "saved $out"
