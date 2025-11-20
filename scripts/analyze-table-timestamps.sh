#!/bin/sh
#
# Analyze timestamp-like columns for one or more tables.
# Requires SOURCE_* connection environment variables, similar to other scripts.
#
# Usage:
#   SOURCE_HOST=... SOURCE_DB=... ./scripts/analyze-table-timestamps.sh orders positions
#

set -e

if [ $# -eq 0 ]; then
  echo "Usage: $0 <table1> [table2 ...]" >&2
  exit 1
fi

REQUIRED_VARS="SOURCE_HOST SOURCE_PORT SOURCE_DB SOURCE_USER SOURCE_PASS"
for VAR in $REQUIRED_VARS; do
  eval "VALUE=\${$VAR:-}"
  if [ -z "$VALUE" ]; then
    echo "Missing required environment variable: $VAR" >&2
    exit 1
  fi
done

PGPASSWORD="$SOURCE_PASS"
export PGPASSWORD

psql_cmd() {
  psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -At "$@"
}

strip_quotes() {
  printf '%s' "$1" | sed 's/^"//;s/"$//'
}

quote_ident() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g')"
}

detect_strategy() {
  column_name="$1"
  data_type="$2"
  lower_name=$(printf '%s' "$column_name" | tr '[:upper:]' '[:lower:]')
  lower_type=$(printf '%s' "$data_type" | tr '[:upper:]' '[:lower:]')

  case "$lower_type" in
    *"timestamp with time zone"*)
      echo "timestamptz"
      return
      ;;
    *"timestamp"*)
      echo "timestamp"
      return
      ;;
  esac

  case "$lower_type" in
    bigint|integer|numeric|"double precision"|real|smallint)
      if printf '%s' "$lower_name" | grep -Eq 'millis|_ms$'; then
        echo "epoch_millis"
      else
        echo "epoch_seconds"
      fi
      return
      ;;
  esac

  echo "timestamp"
}

build_format_expr() {
  column_ident="$1"
  strategy="$2"
  case "$strategy" in
    timestamptz)
      printf '%s::timestamptz' "$column_ident"
      ;;
    timestamp)
      printf '%s::timestamp' "$column_ident"
      ;;
    epoch_millis)
      printf 'to_timestamp(%s::double precision / 1000.0)' "$column_ident"
      ;;
    epoch_seconds|*)
      printf 'to_timestamp(%s::double precision)' "$column_ident"
      ;;
  esac
}

while [ $# -gt 0 ]; do
  INPUT_TABLE="$1"
  shift

  if printf '%s' "$INPUT_TABLE" | grep -q '\.'; then
    SCHEMA=$(printf '%s' "$INPUT_TABLE" | cut -d'.' -f1)
    TABLE=$(printf '%s' "$INPUT_TABLE" | cut -d'.' -f2-)
  else
    SCHEMA="public"
    TABLE="$INPUT_TABLE"
  fi

  SCHEMA=$(strip_quotes "$SCHEMA")
  TABLE=$(strip_quotes "$TABLE")

  echo "Analyzing ${SCHEMA}.${TABLE}..."

  COLUMN_ROWS=$(psql_cmd <<SQL
SELECT column_name || '|' || data_type
FROM information_schema.columns
WHERE table_schema = '${SCHEMA}'
  AND table_name = '${TABLE}'
  AND (
    data_type ILIKE '%timestamp%'
    OR data_type IN ('bigint','integer','numeric','double precision','real','smallint')
    OR column_name ILIKE '%timestamp%'
    OR column_name ILIKE '%time%'
    OR column_name ILIKE '%block%'
  )
ORDER BY ordinal_position;
SQL
)

  if [ -z "$COLUMN_ROWS" ]; then
    echo "  No timestamp-like columns found."
    echo ""
    continue
  fi

  FULL_TABLE=$(quote_ident "$SCHEMA").$(quote_ident "$TABLE")

  echo "$COLUMN_ROWS" | while IFS='|' read -r COLUMN_NAME DATA_TYPE; do
    STRATEGY=$(detect_strategy "$COLUMN_NAME" "$DATA_TYPE")
    COLUMN_IDENT=$(quote_ident "$COLUMN_NAME")
    FORMAT_EXPR=$(build_format_expr "$COLUMN_IDENT" "$STRATEGY")

    STATS=$(psql_cmd <<SQL
SELECT
  COALESCE(MIN(${COLUMN_IDENT})::text, 'NULL'),
  COALESCE(MAX(${COLUMN_IDENT})::text, 'NULL'),
  COALESCE(MIN(${FORMAT_EXPR})::text, 'NULL'),
  COALESCE(MAX(${FORMAT_EXPR})::text, 'NULL'),
  COUNT(*) FILTER (WHERE ${COLUMN_IDENT} IS NULL)
FROM ${FULL_TABLE};
SQL
)

    MIN_RAW=$(printf '%s' "$STATS" | cut -d'|' -f1)
    MAX_RAW=$(printf '%s' "$STATS" | cut -d'|' -f2)
    MIN_TS=$(printf '%s' "$STATS" | cut -d'|' -f3)
    MAX_TS=$(printf '%s' "$STATS" | cut -d'|' -f4)
    NULLS=$(printf '%s' "$STATS" | cut -d'|' -f5)

    echo "  • ${COLUMN_NAME} (${DATA_TYPE}) [${STRATEGY}]"
    echo "      Raw Range: ${MIN_RAW} → ${MAX_RAW}"
    echo "      As Timestamp: ${MIN_TS} → ${MAX_TS}"
    echo "      Null Rows: ${NULLS}"
  done

  echo ""
done

