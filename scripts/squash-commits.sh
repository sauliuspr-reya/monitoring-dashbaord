#!/bin/bash

# Squash all commits into a single commit
# WARNING: This rewrites git history. Only use on feature branches or before first push to main.

set -euo pipefail

echo "=========================================="
echo "Git History Squash"
echo "=========================================="
echo ""
echo "⚠️  WARNING: This will rewrite git history!"
echo ""
echo "This script will:"
echo "  1. Create a backup branch"
echo "  2. Reset to the first commit"
echo "  3. Create a new single commit with all changes"
echo ""

# Check if we're in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "❌ Error: Not in a git repository"
  exit 1
fi

# Check if there are uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo "⚠️  Warning: You have uncommitted changes"
  echo "Please commit or stash them first"
  exit 1
fi

# Get current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Current branch: $CURRENT_BRANCH"
echo ""

# Check if we're on main/master
if [[ "$CURRENT_BRANCH" == "main" ]] || [[ "$CURRENT_BRANCH" == "master" ]]; then
  echo "⚠️  WARNING: You are on $CURRENT_BRANCH branch!"
  read -p "Are you sure you want to squash commits on $CURRENT_BRANCH? [y/N]: " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
  fi
fi

# Get commit count
COMMIT_COUNT=$(git rev-list --count HEAD)
echo "Total commits: $COMMIT_COUNT"
echo ""

if [[ $COMMIT_COUNT -le 1 ]]; then
  echo "Only 1 commit, nothing to squash."
  exit 0
fi

read -p "Squash all $COMMIT_COUNT commits into 1? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "Creating backup branch..."
BACKUP_BRANCH="${CURRENT_BRANCH}-backup-$(date +%Y%m%d-%H%M%S)"
git branch "$BACKUP_BRANCH"
echo "✓ Backup created: $BACKUP_BRANCH"
echo ""

echo "Finding first commit..."
FIRST_COMMIT=$(git rev-list --max-parents=0 HEAD)
echo "First commit: $FIRST_COMMIT"
echo ""

echo "Resetting to first commit (soft reset - keeps changes)..."
git reset --soft "$FIRST_COMMIT"
echo "✓ Reset complete"
echo ""

echo "Creating new single commit..."
git add -A
git commit -m "Initial commit: Replication Monitoring Dashboard

- Next.js dashboard for monitoring PostgreSQL logical replication
- Table monitoring with row counts and sizes
- Replication status tracking and lag monitoring
- Conflict detection and resolution
- Backup management
- Service write tracking
- Goldsky integration
- Docker deployment ready
- Helm/ArgoCD compatible"
echo "✓ New commit created"
echo ""

echo "=========================================="
echo "✓ Squash Complete"
echo "=========================================="
echo ""
echo "Your git history has been squashed to a single commit."
echo ""
echo "To push (force push required):"
echo "  git push --force-with-lease origin $CURRENT_BRANCH"
echo ""
echo "If something goes wrong, restore from backup:"
echo "  git reset --hard $BACKUP_BRANCH"
echo ""

