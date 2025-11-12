# Replication Monitoring Dashboard

A Next.js dashboard for monitoring PostgreSQL logical replication between RDS and GCP Cloud SQL.

## Features

- **Table Monitoring**: View all tables from source and target databases with row counts and sizes
- **Replication Status**: Track subscription status, lag, and worker health
- **Conflict Detection**: Identify and resolve replication conflicts
- **Backup Management**: Create and restore database backups
- **Service Tracking**: Monitor which services write to which tables
- **Goldsky Integration**: Track tables indexed by Goldsky pipelines

## Deployment

This application is deployed via Helm and ArgoCD using the `nextjs-app` chart.

### Docker Build and Push

**Quick build and push:**
```bash
./scripts/build-and-push.sh [version]
# Example: ./scripts/build-and-push.sh v1.0.0
```

**Or using Make:**
```bash
make build-push VERSION=v1.0.0
# Or just: make build-push  # Uses 'latest' tag
```

**Manual steps:**
```bash
# 1. Authenticate with Google Cloud
gcloud auth login
gcloud auth configure-docker gcr.io

# 2. Build the image
docker build -t gcr.io/mainnet-473609/monitoring-dashbaord:latest .

# 3. Push to GCR
docker push gcr.io/mainnet-473609/monitoring-dashbaord:latest
```

### Required Environment Variables

Configure via External Secrets or Helm values:

**Monitoring Database** (required):
- `MONITORING_DB_HOST` - Monitoring database host
- `MONITORING_DB_PORT` - Monitoring database port (default: 5432)
- `MONITORING_DB_NAME` - Monitoring database name
- `MONITORING_DB_USER` - Monitoring database user
- `MONITORING_DB_PASSWORD` - Monitoring database password

**Source/Target Databases** (optional, for viewing tables without subscriptions):
- `SOURCE_DATABASE_URL` - Source database connection string
- `TARGET_DATABASE_URL` - Target database connection string (or `DESTINATION_DATABASE_URL`)

**Authentication** (optional):
- `AUTH_USERNAME` - Basic auth username (default: admin)
- `AUTH_PASSWORD` - Basic auth password (required if AUTH_ENABLED is true)
- `AUTH_ENABLED` - Enable basic auth (default: true)

### Port

The application runs on port **3002**. Health endpoint: `/api/health`

## Development

```bash
npm install
npm run dev
```

## License

Private - Reya Labs

# monitoring-dashbaord
