#!/bin/bash
set -euo pipefail

# Script to check git history for leaked secrets
# Uses multiple detection methods for comprehensive coverage

echo "========================================="
echo "Git Secrets Scanner"
echo "========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo -e "${RED}❌ Error: Not in a git repository${NC}"
  exit 1
fi

echo "✓ Git repository detected"
echo ""

# Create temporary directory for results
TEMP_DIR=$(mktemp -d)
RESULTS_FILE="$TEMP_DIR/secrets-found.txt"
echo "Results will be saved to: $RESULTS_FILE"
echo ""

# Pattern definitions for common secrets
declare -a SECRET_PATTERNS=(
  # Database connection strings
  "postgresql://[^[:space:]]+:[^[:space:]]+@"
  "postgres://[^[:space:]]+:[^[:space:]]+@"
  "mysql://[^[:space:]]+:[^[:space:]]+@"
  
  # Environment variables with passwords
  "PASSWORD[=:][[:space:]]*['\"]?[^[:space:]]{8,}['\"]?"
  "DATABASE_URL[=:][[:space:]]*['\"]?postgresql://"
  "SOURCE_DATABASE_URL[=:][[:space:]]*['\"]?postgresql://"
  "TARGET_DATABASE_URL[=:][[:space:]]*['\"]?postgresql://"
  "MONITORING_DB_PASSWORD[=:][[:space:]]*['\"]?[^[:space:]]{8,}['\"]?"
  
  # API keys
  "api[_-]?key[=:][[:space:]]*['\"]?[A-Za-z0-9_-]{20,}['\"]?"
  "apikey[=:][[:space:]]*['\"]?[A-Za-z0-9_-]{20,}['\"]?"
  "secret[=:][[:space:]]*['\"]?[A-Za-z0-9_-]{20,}['\"]?"
  
  # AWS keys
  "AKIA[0-9A-Z]{16}"
  "aws[_-]?secret[_-]?access[_-]?key[=:][[:space:]]*['\"]?[A-Za-z0-9/+=]{40}['\"]?"
  
  # GCP service account keys
  "\"type\":[[:space:]]*\"service_account\""
  "\"private_key\":[[:space:]]*\"-----BEGIN"
  
  # Generic base64 encoded secrets (long strings)
  "[A-Za-z0-9/+=]{50,}"
  
  # JWT tokens
  "eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"
)

# Function to check if a pattern matches (with context)
check_pattern() {
  local pattern=$1
  local file=$2
  
  # Use git log to search through history
  git log --all --full-history --source --pretty=format:"%H|%an|%ae|%ad|%s" --date=iso -- "$file" | while IFS='|' read -r hash author email date subject; do
    # Get the file content at that commit
    if git cat-file -e "$hash:$file" 2>/dev/null; then
      local content=$(git show "$hash:$file" 2>/dev/null || echo "")
      
      # Check for pattern matches
      if echo "$content" | grep -iE "$pattern" > /dev/null 2>&1; then
        echo "FOUND|$hash|$file|$author|$email|$date|$subject|$pattern" >> "$RESULTS_FILE"
        
        # Show the matching lines with context
        echo "" >> "$RESULTS_FILE"
        echo "--- Match in commit $hash (${date}) ---" >> "$RESULTS_FILE"
        echo "Author: $author <$email>" >> "$RESULTS_FILE"
        echo "Subject: $subject" >> "$RESULTS_FILE"
        echo "File: $file" >> "$RESULTS_FILE"
        echo "Pattern: $pattern" >> "$RESULTS_FILE"
        echo "" >> "$RESULTS_FILE"
        echo "$content" | grep -iE -C 3 "$pattern" >> "$RESULTS_FILE"
        echo "" >> "$RESULTS_FILE"
        echo "========================================" >> "$RESULTS_FILE"
        echo "" >> "$RESULTS_FILE"
      fi
    fi
  done
}

# Get list of files to check (exclude node_modules, .git, etc.)
echo "Scanning git history for secrets..."
echo ""

FILES_TO_CHECK=$(git ls-files | grep -vE "(node_modules|\.git|\.next|\.env|package-lock|yarn.lock)" || true)

if [ -z "$FILES_TO_CHECK" ]; then
  echo -e "${YELLOW}⚠ No files to check${NC}"
  exit 0
fi

TOTAL_FILES=$(echo "$FILES_TO_CHECK" | wc -l | tr -d ' ')
echo "Checking $TOTAL_FILES files..."
echo ""

# Check each pattern against all files
PATTERN_COUNT=${#SECRET_PATTERNS[@]}
CURRENT_PATTERN=0

for pattern in "${SECRET_PATTERNS[@]}"; do
  CURRENT_PATTERN=$((CURRENT_PATTERN + 1))
  echo -n "Checking pattern $CURRENT_PATTERN/$PATTERN_COUNT: ${pattern:0:50}... "
  
  FOUND_COUNT=0
  while IFS= read -r file; do
    if [ -n "$file" ]; then
      check_pattern "$pattern" "$file" &
    fi
  done <<< "$FILES_TO_CHECK"
  
  wait
  echo "done"
done

echo ""
echo "========================================="
echo "Scan Complete"
echo "========================================="
echo ""

# Check results
if [ -f "$RESULTS_FILE" ] && [ -s "$RESULTS_FILE" ]; then
  SECRET_COUNT=$(grep -c "^FOUND|" "$RESULTS_FILE" 2>/dev/null || echo "0")
  
  if [ "$SECRET_COUNT" -gt 0 ]; then
    echo -e "${RED}⚠ WARNING: Found $SECRET_COUNT potential secret(s) in git history${NC}"
    echo ""
    echo "Results saved to: $RESULTS_FILE"
    echo ""
    echo "Summary of findings:"
    echo "===================="
    grep "^FOUND|" "$RESULTS_FILE" | cut -d'|' -f2-4 | sort -u | while IFS='|' read -r hash file author; do
      echo "  - $file (commit: ${hash:0:8}, author: $author)"
    done
    echo ""
    echo -e "${YELLOW}⚠ ACTION REQUIRED:${NC}"
    echo "  1. Review the results file: $RESULTS_FILE"
    echo "  2. Verify if these are actual secrets or false positives"
    echo "  3. If secrets are found, use scripts/remove-secrets-from-git.sh to remove them"
    echo ""
    echo "To view full results:"
    echo "  cat $RESULTS_FILE"
  else
    echo -e "${GREEN}✓ No secrets found in git history${NC}"
    rm -f "$RESULTS_FILE"
  fi
else
  echo -e "${GREEN}✓ No secrets found in git history${NC}"
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "Done!"

