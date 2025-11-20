#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/verify-gap-range.sh <table> <pk_column> <start_pk> <end_pk> [schema]

Requires SOURCE_DATABASE_URL and TARGET_DATABASE_URL to be set (e.g. via .env.local).
EOF
  exit 1
}

if [[ $# -lt 4 || $# -gt 5 ]]; then
  usage
fi

TABLE_NAME="$1"
PK_COLUMN="$2"
START_PK="$3"
END_PK="$4"
SCHEMA_NAME="${5:-public}"

if [[ -z "${SOURCE_DATABASE_URL:-}" || -z "${TARGET_DATABASE_URL:-}" ]]; then
  echo "ERROR: SOURCE_DATABASE_URL and TARGET_DATABASE_URL must be set." >&2
  exit 2
fi

SQL="
  SELECT COUNT(*) AS count
  FROM ${SCHEMA_NAME}.${TABLE_NAME}
  WHERE ${PK_COLUMN} BETWEEN '${START_PK}' AND '${END_PK}';
"

echo "Checking range ${SCHEMA_NAME}.${TABLE_NAME}.${PK_COLUMN} between ${START_PK} and ${END_PK}"
echo

echo "Source (${SOURCE_DATABASE_URL%%\?*}):"
SOURCE_COUNT=$(psql "$SOURCE_DATABASE_URL" -At -c "$SQL")
echo "  Rows: $SOURCE_COUNT"
echo

echo "Target (${TARGET_DATABASE_URL%%\?*}):"
TARGET_COUNT=$(psql "$TARGET_DATABASE_URL" -At -c "$SQL")
echo "  Rows: $TARGET_COUNT"
echo

if [[ "$SOURCE_COUNT" == "$TARGET_COUNT" ]]; then
  echo "✅ Counts match."
  exit 0
else
  echo "⚠️ Counts differ (source=$SOURCE_COUNT target=$TARGET_COUNT)" >&2
  exit 3
fi

