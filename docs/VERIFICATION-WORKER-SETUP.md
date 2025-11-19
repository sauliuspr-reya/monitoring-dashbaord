# Verification Worker Setup (Option 1: Same Container)

## ✅ Implementation Complete

The verification worker is now configured to run in the same container as the Next.js app using the instrumentation hook.

## What Was Changed

1. **Fixed package.json**: Changed `tsx` → `ts-node` (moved to dependencies)
2. **Created `instrumentation.ts`**: Next.js hook that starts the worker on server startup
3. **Updated `next.config.js`**: Enabled `instrumentationHook` experimental feature
4. **Updated `Dockerfile`**: Added copy step for `lib/` directory (worker source files)

## How to Enable

### In Kubernetes Deployment

Add this environment variable to your deployment:

```yaml
env:
  - name: ENABLE_VERIFICATION_WORKER
    value: "true"
```

### Example K8s Deployment Update

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: reya-mainnet-monitoring-dashboard
  namespace: reya-mainnet
spec:
  template:
    spec:
      containers:
      - name: nextjs-app
        image: your-registry/migration-dashboard:latest
        env:
        # ... existing env vars ...
        - name: ENABLE_VERIFICATION_WORKER
          value: "true"
```

## How It Works

1. When the Next.js server starts, the `instrumentation.ts` hook runs
2. It checks for `ENABLE_VERIFICATION_WORKER=true`
3. If enabled, it dynamically imports and starts the `VerificationWorker`
4. The worker runs in the background, polling for verification jobs

## Verification

After deploying, check the logs:

```bash
kubectl logs -n reya-mainnet deployment/reya-mainnet-monitoring-dashboard | grep instrumentation
```

You should see:
```
[instrumentation] Starting verification worker...
[verification-worker] Worker started
```

## Disabling the Worker

To disable, either:
- Remove the `ENABLE_VERIFICATION_WORKER` env var, or
- Set it to `false` or any value other than `"true"`

## Troubleshooting

### Worker not starting
- Check logs for `[instrumentation]` messages
- Verify `ENABLE_VERIFICATION_WORKER=true` is set
- Check that `lib/` directory is in the Docker image

### TypeScript import errors
- Ensure `ts-node` is in `dependencies` (not `devDependencies`)
- Verify `lib/` directory is copied in Dockerfile

### Worker crashes
- Check database connection strings are set
- Verify monitoring database is accessible
- Check worker logs for specific errors

