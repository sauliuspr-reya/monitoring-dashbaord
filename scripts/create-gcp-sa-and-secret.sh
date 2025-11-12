#!/bin/bash

# Script to create GCP service account and GitHub secret
# This automates the entire setup process

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-mainnet-473609}"
SA_NAME="${SA_NAME:-github-actions-docker}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
KEY_FILE="${KEY_FILE:-github-actions-key.json}"

echo "=========================================="
echo "Creating GCP Service Account for GitHub Actions"
echo "=========================================="
echo ""
echo "Project: $PROJECT_ID"
echo "Service Account: $SA_EMAIL"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
  echo "❌ Error: gcloud CLI is not installed"
  exit 1
fi

# Check if gh CLI is installed (for GitHub secret)
if ! command -v gh &> /dev/null; then
  echo "⚠️  Warning: GitHub CLI (gh) is not installed"
  echo "You'll need to manually add the secret to GitHub"
fi

# Set the project
echo "Setting GCP project..."
gcloud config set project "$PROJECT_ID"

# Enable required APIs
echo ""
echo "Enabling required APIs..."
gcloud services enable artifactregistry.googleapis.com --quiet || true
gcloud services enable iam.googleapis.com --quiet || true

# Check if service account already exists
if gcloud iam service-accounts describe "$SA_EMAIL" &>/dev/null; then
  echo ""
  echo "⚠️  Service account already exists: $SA_EMAIL"
  read -p "Do you want to create a new key for it? [y/N]: " create_key
  if [[ ! "$create_key" =~ ^[Yy]$ ]]; then
    echo "Skipping key creation."
    exit 0
  fi
else
  # Create service account
  echo ""
  echo "Creating service account..."
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="GitHub Actions for Docker Builds" \
    --description="Service account for GitHub Actions to build and push Docker images to Artifact Registry" \
    --project="$PROJECT_ID" || {
    echo "❌ Failed to create service account"
    exit 1
  }
  echo "✓ Service account created"
fi

# Grant permissions
echo ""
echo "Granting permissions..."

# Artifact Registry Writer (for Artifact Registry read/write)
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/artifactregistry.writer" \
  --condition=None \
  --quiet || echo "⚠️  Artifact Registry Writer role may already be granted"

# Service Account User (for authentication)
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/iam.serviceAccountUser" \
  --condition=None \
  --quiet || echo "⚠️  Service Account User role may already be granted"

echo "✓ Permissions granted"

# Create and download key
echo ""
echo "Creating service account key..."
if [ -f "$KEY_FILE" ]; then
  echo "⚠️  Key file already exists: $KEY_FILE"
  read -p "Overwrite? [y/N]: " overwrite
  if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
    echo "Using existing key file."
  else
    rm -f "$KEY_FILE"
    gcloud iam service-accounts keys create "$KEY_FILE" \
      --iam-account="$SA_EMAIL" \
      --project="$PROJECT_ID"
    echo "✓ Key created: $KEY_FILE"
  fi
else
  gcloud iam service-accounts keys create "$KEY_FILE" \
    --iam-account="$SA_EMAIL" \
    --project="$PROJECT_ID"
  echo "✓ Key created: $KEY_FILE"
fi

# Add to GitHub
echo ""
echo "=========================================="
echo "Adding Secret to GitHub"
echo "=========================================="
echo ""

if command -v gh &> /dev/null; then
  # Check if authenticated
  if gh auth status &>/dev/null; then
    echo "Adding GCP_SA_KEY secret to GitHub..."
    if gh secret set GCP_SA_KEY < "$KEY_FILE"; then
      echo "✓ Secret added to GitHub"
      echo ""
      echo "⚠️  SECURITY: Delete the local key file after verifying:"
      echo "   rm $KEY_FILE"
    else
      echo "❌ Failed to add secret to GitHub"
      echo ""
      echo "Manual steps:"
      echo "1. Go to: https://github.com/OWNER/REPO/settings/secrets/actions"
      echo "2. Click 'New repository secret'"
      echo "3. Name: GCP_SA_KEY"
      echo "4. Value: (paste content of $KEY_FILE)"
    fi
  else
    echo "⚠️  GitHub CLI not authenticated"
    echo "Run: gh auth login"
    echo ""
    echo "Or add secret manually:"
    echo "1. Go to: https://github.com/OWNER/REPO/settings/secrets/actions"
    echo "2. Click 'New repository secret'"
    echo "3. Name: GCP_SA_KEY"
    echo "4. Value: (paste content of $KEY_FILE)"
  fi
else
  echo "GitHub CLI not installed. Add secret manually:"
  echo ""
  echo "1. Go to: https://github.com/OWNER/REPO/settings/secrets/actions"
  echo "2. Click 'New repository secret'"
  echo "3. Name: GCP_SA_KEY"
  echo "4. Value: (paste content of $KEY_FILE)"
  echo ""
  echo "Or install GitHub CLI and run:"
  echo "   gh secret set GCP_SA_KEY < $KEY_FILE"
fi

echo ""
echo "=========================================="
echo "✓ Setup Complete"
echo "=========================================="
echo ""
echo "Service Account: $SA_EMAIL"
echo "Key File: $KEY_FILE"
echo ""
echo "⚠️  IMPORTANT: Keep the key file secure!"
echo "   Consider deleting it after adding to GitHub:"
echo "   rm $KEY_FILE"
echo ""
echo "The Artifact Registry repository 'reya' should already exist in europe-west3."
echo ""

