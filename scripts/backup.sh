#!/usr/bin/env bash
# Daily Postgres backup. Run from a cron job:
#   0 2 * * * /opt/popin/backend/scripts/backup.sh >> /var/log/popin-backup.log 2>&1
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/popin}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/popin?schema=public}"
DB_NAME="popin"

# Parse host/port from DATABASE_URL without revealing credentials in logs.
DB_HOST="$(echo "$DB_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')"
DB_PORT="$(echo "$DB_URL" | sed -n 's|.*@[^:]*:\([0-9]*\).*|\1|p')"
DB_USER="$(echo "$DB_URL" | sed -n 's|.*://\([^:]*\):.*|\1|p')"
DB_PASSWORD="$(echo "$DB_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')"
DB_PORT="${DB_PORT:-5432}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="$BACKUP_DIR/${DB_NAME}_${STAMP}.sql.gz"

echo "[backup] starting at $(date -Is)"
PGPASSWORD="$DB_PASSWORD" pg_dump \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
  --no-owner --no-acl \
  "$DB_NAME" | gzip > "$FILE"

echo "[backup] wrote $FILE ($(du -h "$FILE" | cut -f1))"

# Prune old backups.
find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime "+$RETENTION_DAYS" -delete
echo "[backup] retention: keeping last $RETENTION_DAYS days"
echo "[backup] done at $(date -Is)"
