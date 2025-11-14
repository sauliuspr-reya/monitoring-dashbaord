#!/bin/bash
set -euo pipefail

# Install git-secrets (AWS tool for preventing secret commits)
# Also installs truffleHog for scanning existing history

echo "========================================="
echo "Installing Git Secret Scanning Tools"
echo "========================================="
echo ""

# Check OS
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo "Detected macOS"
  INSTALL_CMD="brew install"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  echo "Detected Linux"
  INSTALL_CMD="sudo apt-get install -y"
else
  echo "⚠ Unsupported OS. Please install manually."
  exit 1
fi

# Install git-secrets
echo ""
echo "1. Installing git-secrets..."
if command -v git-secrets &> /dev/null; then
  echo "✓ git-secrets already installed"
else
  if [[ "$OSTYPE" == "darwin"* ]]; then
    brew install git-secrets
  else
    # For Linux, install from source
    cd /tmp
    git clone https://github.com/awslabs/git-secrets.git
    cd git-secrets
    sudo make install
    cd -
    rm -rf /tmp/git-secrets
  fi
  echo "✓ git-secrets installed"
fi

# Install git-filter-repo (for history rewriting)
echo ""
echo "2. Installing git-filter-repo..."
if command -v git-filter-repo &> /dev/null; then
  echo "✓ git-filter-repo already installed"
else
  if [[ "$OSTYPE" == "darwin"* ]]; then
    brew install git-filter-repo
  else
    pip3 install git-filter-repo
  fi
  echo "✓ git-filter-repo installed"
fi

# Install truffleHog (for scanning)
echo ""
echo "3. Installing truffleHog..."
if command -v trufflehog &> /dev/null; then
  echo "✓ truffleHog already installed"
else
  if command -v pip3 &> /dev/null; then
    pip3 install truffleHog
    echo "✓ truffleHog installed"
  else
    echo "⚠ pip3 not found. Install truffleHog manually: pip3 install truffleHog"
  fi
fi

# Configure git-secrets for this repository
echo ""
echo "4. Configuring git-secrets for this repository..."
cd "$(git rev-parse --show-toplevel)"

if git config --get-regexp 'secrets' > /dev/null 2>&1; then
  echo "✓ git-secrets already configured"
else
  git secrets --install
  echo "✓ git-secrets hooks installed"
  
  # Add common patterns
  git secrets --register-aws
  git secrets --add 'postgresql://[^:]+:[^@]+@'
  git secrets --add 'postgres://[^:]+:[^@]+@'
  git secrets --add 'PASSWORD\s*=\s*["\x27][^"\x27]{8,}["\x27]'
  git secrets --add 'DATABASE_URL\s*=\s*["\x27]postgresql://'
  git secrets --add 'MONITORING_DB_PASSWORD\s*=\s*["\x27][^"\x27]{8,}["\x27]'
  
  echo "✓ Common secret patterns registered"
fi

echo ""
echo "========================================="
echo "Setup Complete"
echo "========================================="
echo ""
echo "git-secrets is now configured to:"
echo "  - Prevent committing secrets in the future"
echo "  - Scan commits before they're made"
echo ""
echo "To scan existing history, run:"
echo "  ./scripts/check-git-secrets.sh"
echo ""
echo "Or use truffleHog:"
echo "  trufflehog git file://. --since-commit HEAD~100"
echo ""

