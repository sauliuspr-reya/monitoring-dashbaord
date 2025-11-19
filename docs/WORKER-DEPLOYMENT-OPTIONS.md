# Worker Deployment Options

## Current Issue
The verification worker uses `tsx` which is not available in production. Here are the deployment options:

## Option 1: Run in Same Container as Next.js App (Recommended for Simplicity)

**Pros:**
- ✅ Simplest deployment (no separate containers)
- ✅ Shares environment variables automatically
- ✅ No additional K8s resources needed
- ✅ Easy to debug (logs in same pod)

**Cons:**
- ⚠️ Shares resources with web app (CPU/memory)
- ⚠️ If worker crashes, could affect web app (mitigated by error handling)
- ⚠️ Single point of failure

**Implementation:**
Start worker when Next.js app starts:

```typescript
// pages/_app.tsx or server.js
import { VerificationWorker } from '@/lib/worker/verification-worker';

if (process.env.ENABLE_VERIFICATION_WORKER === 'true') {
  const worker = new VerificationWorker();
  worker.start().catch(console.error);
}
```

**K8s Config:**
```yaml
env:
  - name: ENABLE_VERIFICATION_WORKER
    value: "true"
```

---

## Option 2: Separate K8s Deployment (Recommended for Production)

**Pros:**
- ✅ Process isolation (worker crash doesn't affect web app)
- ✅ Independent scaling
- ✅ Resource limits per service
- ✅ Can restart worker without affecting web app

**Cons:**
- ⚠️ More complex deployment (separate deployment)
- ⚠️ Need to share env vars/secrets

**Implementation:**
Create `k8s/verification-worker-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: verification-worker
  namespace: reya-mainnet
spec:
  replicas: 1  # Only one worker instance
  selector:
    matchLabels:
      app: verification-worker
  template:
    metadata:
      labels:
        app: verification-worker
    spec:
      containers:
      - name: worker
        image: your-registry/migration-dashboard:latest
        command:
          - node
          - -r
          - ts-node/register
          - lib/worker/verification-worker.js
        # Or use compiled JS:
        # command: ["node", "lib/worker/verification-worker.js"]
        env:
        - name: SOURCE_DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: reya-mainnet-monitoring-dashboard-secret
              key: source-database-url
        - name: TARGET_DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: reya-mainnet-monitoring-dashboard-secret
              key: target-database-url
        # ... other env vars
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
```

---

## Option 3: Compile to JavaScript (Best for Production)

**Pros:**
- ✅ No TypeScript runtime needed
- ✅ Faster startup
- ✅ Smaller image (no ts-node/tsx)

**Cons:**
- ⚠️ Need to compile before deployment
- ⚠️ Extra build step

**Implementation:**

1. Update `package.json`:
```json
{
  "scripts": {
    "build": "next build && tsc --project tsconfig.workers.json",
    "verification-worker": "node lib/worker/verification-worker.js"
  }
}
```

2. Create `tsconfig.workers.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./",
    "rootDir": "./lib"
  },
  "include": ["lib/worker/**/*"]
}
```

3. Update Dockerfile to compile workers:
```dockerfile
RUN npm run build  # This now compiles workers too
```

---

## Option 4: Use Next.js API Route (Not Recommended for Long-Running)

**Pros:**
- ✅ No separate process needed
- ✅ Uses existing Next.js infrastructure

**Cons:**
- ❌ Blocks API request (bad for long-running tasks)
- ❌ Timeout issues
- ❌ Not suitable for continuous polling

**Only use for:** Short tasks (< 30 seconds)

---

## Option 5: K8s CronJob (For Scheduled Tasks Only)

**Pros:**
- ✅ Good for periodic tasks
- ✅ Automatic scheduling

**Cons:**
- ❌ Not suitable for continuous workers
- ❌ Verification worker needs to run continuously

**Use for:** Rate-of-change collector, periodic metrics

---

## Recommended Approach

### For Development/Simple Setup:
**Option 1** - Run in same container with env flag

### For Production:
**Option 3** (Compile to JS) + **Option 2** (Separate Deployment)

This gives you:
- Fast startup (no TypeScript compilation)
- Process isolation
- Independent scaling
- Production-ready

---

## Quick Fix (Immediate) ✅ IMPLEMENTED

1. **Fixed package.json**: Changed `tsx` → `ts-node` (already in dependencies)

2. **Option 1: Run in Same Container** ✅ RECOMMENDED
   - Created `instrumentation.ts` hook (runs when Next.js starts)
   - Enabled in `next.config.js`
   - Set `ENABLE_VERIFICATION_WORKER=true` in K8s deployment

3. **Option 2: Separate K8s Deployment**
   - Created `k8s/verification-worker-deployment.yaml`
   - Use this if you want process isolation

## How to Use

### Same Container (Current Setup):
```yaml
# In your K8s deployment
env:
  - name: ENABLE_VERIFICATION_WORKER
    value: "true"
```

The worker will start automatically when the Next.js app starts.

### Separate Container:
```bash
kubectl apply -f k8s/verification-worker-deployment.yaml
```

This runs the worker in a separate pod with its own resources.

