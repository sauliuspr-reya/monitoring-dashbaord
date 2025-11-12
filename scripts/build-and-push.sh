#!/bin/bash

set -euo pipefail

# Build and push Docker image to Google Artifact Registry
# Usage: ./scripts/build-and-push.sh [version] [platform]
# Platform defaults to linux/amd64

IMAGE_REPO="europe-west3-docker.pkg.dev/mainnet-473609/reya/monitoring-dashbaord"
VERSION="${1:-latest}"
PLATFORM="${2:-linux/amd64}"

echo "=========================================="
echo "Building Docker Image"
echo "=========================================="
echo ""
echo "Repository: ${IMAGE_REPO}"
echo "Version: ${VERSION}"
echo "Platform: ${PLATFORM}"
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

# Authenticate with Artifact Registry (if not already authenticated)
echo "Checking Artifact Registry authentication..."
if ! gcloud auth print-access-token &> /dev/null; then
  echo "Authenticating with Google Cloud..."
  gcloud auth login
fi

# Configure Docker to use gcloud as a credential helper
echo "Configuring Docker credential helper..."
gcloud auth configure-docker europe-west3-docker.pkg.dev --quiet

# Build the image for amd64 architecture
echo ""
echo "Building Docker image for ${PLATFORM}..."
docker build --platform="${PLATFORM}" -t "${IMAGE_REPO}:${VERSION}" .

# Also tag as latest if version is not latest
if [[ "${VERSION}" != "latest" ]]; then
  echo "Tagging as latest..."
  docker tag "${IMAGE_REPO}:${VERSION}" "${IMAGE_REPO}:latest"
fi

# Push the image
echo ""
echo "Pushing image to Artifact Registry..."
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

