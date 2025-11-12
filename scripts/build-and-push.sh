#!/bin/bash

set -euo pipefail

# Build and push Docker image to Google Container Registry
# Usage: ./scripts/build-and-push.sh [version]

IMAGE_REPO="gcr.io/mainnet-473609/monitoring-dashbaord"
VERSION="${1:-latest}"

echo "=========================================="
echo "Building Docker Image"
echo "=========================================="
echo ""
echo "Repository: ${IMAGE_REPO}"
echo "Version: ${VERSION}"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
  echo "❌ Error: gcloud CLI is not installed"
  echo "Install it from: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Check if docker is installed
if ! command -v docker &> /dev/null; then
  echo "❌ Error: Docker is not installed"
  exit 1
fi

# Authenticate with GCR (if not already authenticated)
echo "Checking GCR authentication..."
if ! gcloud auth print-access-token &> /dev/null; then
  echo "Authenticating with Google Cloud..."
  gcloud auth login
fi

# Configure Docker to use gcloud as a credential helper
echo "Configuring Docker credential helper..."
gcloud auth configure-docker gcr.io --quiet

# Build the image
echo ""
echo "Building Docker image..."
docker build -t "${IMAGE_REPO}:${VERSION}" .

# Also tag as latest if version is not latest
if [[ "${VERSION}" != "latest" ]]; then
  echo "Tagging as latest..."
  docker tag "${IMAGE_REPO}:${VERSION}" "${IMAGE_REPO}:latest"
fi

# Push the image
echo ""
echo "Pushing image to GCR..."
docker push "${IMAGE_REPO}:${VERSION}"

if [[ "${VERSION}" != "latest" ]]; then
  docker push "${IMAGE_REPO}:latest"
fi

echo ""
echo "=========================================="
echo "✓ Success!"
echo "=========================================="
echo ""
echo "Image pushed: ${IMAGE_REPO}:${VERSION}"
if [[ "${VERSION}" != "latest" ]]; then
  echo "Also tagged as: ${IMAGE_REPO}:latest"
fi
echo ""
echo "Use this in your Helm values:"
echo "  image:"
echo "    repository: ${IMAGE_REPO}"
echo "    tag: ${VERSION}"
echo ""

