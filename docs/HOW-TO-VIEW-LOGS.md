# How to View Duration Logs

## No Environment Variable Needed

The duration logs are **always enabled** - they use `console.log()` which outputs to stdout/stderr automatically.

## Where to Find Logs

### 1. **Kubernetes (Production)**

If you're running in Kubernetes, use the existing script:

```bash
# View recent logs
./scripts/get-pod-logs.sh

# View logs with errors only
./scripts/get-pod-logs.sh errors

# Follow logs in real-time
./scripts/get-pod-logs.sh follow
```

Or manually with kubectl:

```bash
# Find your pod
kubectl get pods -n <namespace>

# View logs
kubectl logs -n <namespace> <pod-name> --tail=100

# Follow logs in real-time
kubectl logs -n <namespace> <pod-name> -f

# Filter for subscription tables logs
kubectl logs -n <namespace> <pod-name> | grep "subscriptions/.*/tables"
```

### 2. **Local Development**

If running locally with `npm run dev` or `yarn dev`:

- Logs appear in the **terminal/console** where you started the server
- Look for lines starting with `[subscriptions/{id}/tables]`

### 3. **Docker**

If running in Docker:

```bash
# View container logs
docker logs <container-name> --tail=100 -f

# Filter for subscription tables logs
docker logs <container-name> | grep "subscriptions/.*/tables"
```

## What You'll See

When you load the tables page, you'll see logs like:

```
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Starting request at 2025-01-16T12:00:00.000Z
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Step 1 (subscription lookup): 5ms
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Skipping application write stats (use ?includeWriters=true to enable)
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Step 2 (get publication tables): 10ms - Found 141 tables
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Step 3 (source bulk stats): 50ms - Fetched 141 tables
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Step 4 (target bulk stats): 45ms - Fetched 141 tables
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Step 5 (identify small tables): 1ms - Using estimates for 131 tables, exact COUNT(*) for 10 small tables only
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Getting exact counts for 10 small tables in batches of 3
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Step 6 (exact counts): 5000ms - Fetched exact counts for 10 tables
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Step 7 (historical metrics): 20ms - Fetched historical metrics for 50 tables
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] Step 8 (build stats): 5ms - Built stats for 141 tables
[subscriptions/70218a11-614b-4a56-a106-86045b67ce56/tables] TOTAL TIME: 5136ms (metrics storage in background)
```

## Identifying Bottlenecks

Look for steps with high duration:

- **Step 6 (exact counts) > 5 seconds**: COUNT(*) queries are slow → Consider disabling them
- **Step 3/4 (bulk stats) > 1 second**: Database connection or query is slow → Check network/DB performance
- **Step 7 (historical metrics) > 1 second**: Monitoring DB is slow → Check monitoring DB performance
- **Total time > 10 seconds**: Multiple bottlenecks → Check all steps

## Filtering Logs

### Grep for specific subscription:

```bash
kubectl logs -n <namespace> <pod-name> | grep "subscriptions/70218a11"
```

### Grep for timing logs only:

```bash
kubectl logs -n <namespace> <pod-name> | grep "Step\|TOTAL TIME"
```

### Grep for errors:

```bash
kubectl logs -n <namespace> <pod-name> | grep "ERROR\|Failed\|timeout"
```

## Example: Real-time Monitoring

```bash
# Watch logs in real-time and filter for subscription tables
kubectl logs -n <namespace> <pod-name> -f | grep --line-buffered "subscriptions/.*/tables"
```

This will show you logs as they happen when someone loads the tables page.

