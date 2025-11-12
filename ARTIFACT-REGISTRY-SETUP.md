# Artifact Registry Setup Guide

## Repository Information

- **Project**: `mainnet-473609`
- **Location**: `europe-west3`
- **Repository**: `reya`
- **Image**: `monitoring-dashbaord`
- **Full Image Path**: `europe-west3-docker.pkg.dev/mainnet-473609/reya/monitoring-dashbaord`

## Quick Setup (Automated)

Run the automated script to create everything:

```bash
./scripts/create-gcp-sa-and-secret.sh
```

This will:
1. Create a GCP service account
2. Grant necessary permissions (`roles/artifactregistry.writer`)
3. Create a service account key
4. Add it to GitHub secrets (if GitHub CLI is installed)

## Manual Setup

### Step 1: Create Service Account

```bash
PROJECT_ID="mainnet-473609"
SA_NAME="github-actions-docker"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Set project
gcloud config set project $PROJECT_ID

# Enable APIs
gcloud services enable artifactregistry.googleapis.com
gcloud services enable iam.googleapis.com

# Create service account
gcloud iam service-accounts create $SA_NAME \
  --display-name="GitHub Actions for Docker Builds" \
  --project=$PROJECT_ID
```

### Step 2: Grant Permissions

```bash
# Artifact Registry Writer (for read/write access)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/artifactregistry.writer"

# Service Account User (for authentication)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/iam.serviceAccountUser"
```

**Alternative**: If you need admin access:
```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/artifactregistry.admin"
```

### Step 3: Create Key

```bash
# Create and download key
gcloud iam service-accounts keys create github-actions-key.json \
  --iam-account=$SA_EMAIL \
  --project=$PROJECT_ID
```

### Step 4: Add to GitHub Secrets

**Option A: Using GitHub CLI**

```bash
# Authenticate first
gh auth login

# Add secret
gh secret set GCP_SA_KEY < github-actions-key.json
```

**Option B: Manual (Web UI)**

1. Go to: `https://github.com/OWNER/REPO/settings/secrets/actions`
2. Click "New repository secret"
3. Name: `GCP_SA_KEY`
4. Value: Paste the entire content of `github-actions-key.json`
5. Click "Add secret"

### Step 5: Clean Up

```bash
# Delete the local key file (it's now in GitHub)
rm github-actions-key.json
```

## Verify Setup

```bash
# Test authentication
gcloud auth activate-service-account $SA_EMAIL --key-file=github-actions-key.json
gcloud auth configure-docker europe-west3-docker.pkg.dev

# Test push
docker pull hello-world
docker tag hello-world europe-west3-docker.pkg.dev/$PROJECT_ID/reya/monitoring-dashbaord:test
docker push europe-west3-docker.pkg.dev/$PROJECT_ID/reya/monitoring-dashbaord:test
```

## Troubleshooting

### Error: "repo does not exist. Creating on push requires permission"

**Solution**: The service account needs `roles/artifactregistry.writer` or `roles/artifactregistry.admin`:

```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/artifactregistry.writer"
```

### Error: "Permission denied"

**Solution**: Check that:
1. Service account has `roles/artifactregistry.writer` or `roles/artifactregistry.admin`
2. GitHub secret `GCP_SA_KEY` is set correctly
3. The JSON key is valid
4. The repository `reya` exists in `europe-west3`

### Verify Repository Exists

```bash
# List repositories
gcloud artifacts repositories list \
  --location=europe-west3 \
  --project=mainnet-473609

# If repository doesn't exist, create it:
gcloud artifacts repositories create reya \
  --repository-format=docker \
  --location=europe-west3 \
  --description="Docker repository for Reya services" \
  --project=mainnet-473609
```

## Required Permissions

The service account needs:
- `roles/artifactregistry.writer` - For Artifact Registry read/write operations (recommended)
- OR `roles/artifactregistry.admin` - For full admin access
- `roles/iam.serviceAccountUser` - For authentication

## Security Notes

- ⚠️ **Never commit** the service account key file to git
- ⚠️ **Delete** the local key file after adding to GitHub
- ✅ The key is stored securely in GitHub Secrets
- ✅ Rotate keys periodically (create new key, update GitHub, delete old key)

## Image Reference

In your Helm values or Kubernetes manifests, use:

```yaml
image:
  repository: europe-west3-docker.pkg.dev/mainnet-473609/reya/monitoring-dashbaord
  tag: latest
```

Or in Docker commands:

```bash
docker pull europe-west3-docker.pkg.dev/mainnet-473609/reya/monitoring-dashbaord:latest
```

