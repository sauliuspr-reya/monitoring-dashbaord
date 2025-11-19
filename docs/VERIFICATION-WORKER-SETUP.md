# Verification Worker Setup (Option 1: Same Container)

## ✅ Implementation Complete

The verification worker is now configured to run in the same container as the Next.js app using the instrumentation hook.

## What Was Changed

1. **Fixed package.json**: Changed `tsx` → `ts-node` (moved to dependencies)
2. **Created `instrumentation.ts`**: Next.js hook that starts the worker on server startup
3. **Updated `next.config.js`**: Enabled `instrumentationHook` experimental feature
4. **Updated `Dockerfile`**: Added copy step for `lib/` directory (worker source files)

## Behavior

**The worker is always enabled** and will start automatically when the Next.js server starts.

There is no configuration needed - the worker runs automatically as part of the Next.js application process.

### How It Works

1. Next.js server starts
2. `instrumentation.ts` hook is called
3. Worker starts automatically in the same process
4. Worker polls for verification jobs every 5 seconds
5. Progress updates are written to the database every 5 seconds

### Example K8s Deployment

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
        # ... existing env vars (SOURCE_DATABASE_URL, TARGET_DATABASE_URL, etc.) ...
```

## How It Works

1. When the Next.js server starts, the `instrumentation.ts` hook runs
2. It dynamically imports and starts the `VerificationWorker`
3. The worker runs in the background, polling for verification jobs every 5 seconds
4. Progress is updated in the database every 5 seconds during processing

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

## Troubleshooting

### Worker not starting
- Check logs for `[instrumentation]` messages
- Verify `lib/` directory is in the Docker image
- Check that instrumentation hook is enabled in `next.config.js`

### TypeScript import errors
- Ensure `ts-node` is in `dependencies` (not `devDependencies`)
- Verify `lib/` directory is copied in Dockerfile

### Worker crashes
- Check database connection strings are set (SOURCE_DATABASE_URL, TARGET_DATABASE_URL)
- Verify monitoring database is accessible
- Check worker logs for specific errors

