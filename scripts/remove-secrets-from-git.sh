#!/bin/bash
set -euo pipefail

# Script to remove secrets from git history
# WARNING: This rewrites git history. Use with caution!

echo "========================================="
echo "Remove Secrets from Git History"
echo "========================================="
echo ""
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}⚠ WARNING: This script will rewrite git history!${NC}"
echo "This will:"
echo "  - Change commit hashes"
echo "  - Require force push to remote"
echo "  - Affect all collaborators"
echo ""
read -p "Are you sure you want to continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "❌ Error: Not in a git repository"
  exit 1
fi

# Check if git-filter-repo is installed (preferred method)
if command -v git-filter-repo &> /dev/null; then
  echo "✓ git-filter-repo found (recommended method)"
  USE_FILTER_REPO=true
else
  echo "⚠ git-filter-repo not found, will use git filter-branch (slower)"
  USE_FILTER_REPO=false
fi

echo ""
echo "This script will help you remove secrets from git history."
echo "You can:"
echo "  1. Remove specific files"
echo "  2. Remove specific patterns from all files"
echo "  3. Remove secrets from specific commits"
echo ""
read -p "Choose option (1/2/3): " option

case $option in
  1)
    echo ""
    echo "Enter file paths to remove (one per line, empty line to finish):"
    FILES_TO_REMOVE=()
    while IFS= read -r line; do
      [ -z "$line" ] && break
      FILES_TO_REMOVE+=("$line")
    done
    
    if [ ${#FILES_TO_REMOVE[@]} -eq 0 ]; then
      echo "No files specified. Aborting."
      exit 1
    fi
    
    echo ""
    echo "Files to remove from history:"
    for file in "${FILES_TO_REMOVE[@]}"; do
      echo "  - $file"
    done
    echo ""
    read -p "Confirm removal? (yes/no): " confirm2
    
    if [ "$confirm2" != "yes" ]; then
      echo "Aborted."
      exit 0
    fi
    
    # Create backup branch first
    BACKUP_BRANCH="backup-before-secret-removal-$(date +%Y%m%d-%H%M%S)"
    git branch "$BACKUP_BRANCH"
    echo "✓ Created backup branch: $BACKUP_BRANCH"
    echo ""
    
    if [ "$USE_FILTER_REPO" = true ]; then
      for file in "${FILES_TO_REMOVE[@]}"; do
        echo "Removing $file from history..."
        git filter-repo --path "$file" --invert-paths --force
      done
    else
      # Use filter-branch
      git filter-branch --force --index-filter \
        "git rm --cached --ignore-unmatch ${FILES_TO_REMOVE[*]}" \
        --prune-empty --tag-name-filter cat -- --all
    fi
    ;;
    
  2)
    echo ""
    echo "Enter pattern to remove (regex, e.g., 'password.*=.*['\"].*['\"]'):"
    read -r PATTERN
    
    echo ""
    echo "Enter replacement text (leave empty to remove completely):"
    read -r REPLACEMENT
    
    if [ -z "$REPLACEMENT" ]; then
      REPLACEMENT="[REDACTED]"
    fi
    
    echo ""
    echo "Pattern: $PATTERN"
    echo "Replacement: $REPLACEMENT"
    read -p "Confirm? (yes/no): " confirm2
    
    if [ "$confirm2" != "yes" ]; then
      echo "Aborted."
      exit 0
    fi
    
    # Create backup branch
    BACKUP_BRANCH="backup-before-secret-removal-$(date +%Y%m%d-%H%M%S)"
    git branch "$BACKUP_BRANCH"
    echo "✓ Created backup branch: $BACKUP_BRANCH"
    echo ""
    
    if [ "$USE_FILTER_REPO" = true ]; then
      echo "Removing pattern from all files..."
      git filter-repo --replace-text <(echo "$PATTERN==>$REPLACEMENT") --force
    else
      # Use filter-branch with sed
      git filter-branch --force --tree-filter \
        "find . -type f -exec sed -i '' 's|$PATTERN|$REPLACEMENT|g' {} +" \
        --prune-empty --tag-name-filter cat -- --all
    fi
    ;;
    
  3)
    echo ""
    echo "Enter commit hash(es) to modify (space-separated):"
    read -r COMMITS
    
    if [ -z "$COMMITS" ]; then
      echo "No commits specified. Aborting."
      exit 1
    fi
    
    # Create backup branch
    BACKUP_BRANCH="backup-before-secret-removal-$(date +%Y%m%d-%H%M%S)"
    git branch "$BACKUP_BRANCH"
    echo "✓ Created backup branch: $BACKUP_BRANCH"
    echo ""
    
    echo "⚠ Manual intervention required for specific commits"
    echo "Consider using interactive rebase:"
    echo "  git rebase -i <commit-before-first>"
    echo "Then mark commits as 'edit' and modify them"
    exit 0
    ;;
    
  *)
    echo "Invalid option. Aborting."
    exit 1
    ;;
esac

echo ""
echo "========================================="
echo "Cleanup"
echo "========================================="
echo ""

# Clean up refs
git for-each-ref --format='delete %(refname)' refs/original | git update-ref --stdin 2>/dev/null || true
git reflog expire --expire=now --all
git gc --prune=now --aggressive

echo "✓ Cleanup complete"
echo ""
echo "========================================="
echo "Next Steps"
echo "========================================="
echo ""
echo "1. Verify the changes:"
echo "   git log --all --oneline"
echo ""
echo "2. If satisfied, force push to remote (⚠ DANGEROUS):"
echo "   git push --force --all"
echo "   git push --force --tags"
echo ""
echo "3. Notify all collaborators to:"
echo "   git fetch --all"
echo "   git reset --hard origin/main  # or your main branch"
echo ""
echo "4. If something went wrong, restore from backup:"
echo "   git reset --hard $BACKUP_BRANCH"
echo ""
echo "⚠ IMPORTANT: After force pushing, all secrets in the old history"
echo "  will still be accessible to anyone who cloned the repo before."
echo "  Consider rotating all exposed secrets!"
echo ""

