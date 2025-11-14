# Task Management Solutions Comparison

## Requirements
- Launch tasks (backup, restore, subscription creation)
- Check/update status
- View stdout/stderr output
- Fast and quick results
- Available: DB, Redis, Kubernetes

## Solution Comparison

### Option 1: Database + File Logging (RECOMMENDED) ⭐

**Implementation:**
- PostgreSQL for task status/metadata
- Files for full logs (in PVC)
- DB stores last 100 lines for quick access
- `spawn()` with streaming for real-time output
- SSE/WebSockets for live updates

**Pros:**
- ✅ Fast to implement (uses existing DB)
- ✅ No additional infrastructure
- ✅ Works perfectly with Kubernetes PVC
- ✅ Real-time streaming possible
- ✅ Full log history in files
- ✅ Quick access via DB

**Cons:**
- ⚠️ File cleanup needed
- ⚠️ Large logs could fill disk (mitigated by cleanup)

**Best For:**
- Fast results
- Kubernetes deployments
- Teams wanting simple solution

**Implementation Time:** 2-4 hours

---

### Option 2: BullMQ + Redis

**Implementation:**
- Redis for job queue
- BullMQ for job management
- Store output in Redis or files
- Built-in retry, prioritization

**Pros:**
- ✅ Professional job queue
- ✅ Built-in retry logic
- ✅ Job prioritization
- ✅ Rate limiting
- ✅ Job progress tracking

**Cons:**
- ❌ Requires Redis infrastructure
- ❌ More complex setup
- ❌ Additional dependency
- ❌ Redis memory limits for logs

**Best For:**
- High-volume task processing
- Need retry/prioritization
- Already have Redis

**Implementation Time:** 1-2 days

---

### Option 3: Kubernetes Jobs

**Implementation:**
- Kubernetes Job for each task
- PVC for logs (shared volume)
- Status via Job status API

**Pros:**
- ✅ Process isolation
- ✅ Resource limits
- ✅ Auto-restart on failure
- ✅ Kubernetes-native

**Cons:**
- ❌ PVC sharing complexity
- ❌ Harder to stream logs
- ❌ More complex deployment
- ❌ Job cleanup needed

**Best For:**
- Need strict isolation
- Resource constraints
- Kubernetes-native workflows

**Implementation Time:** 2-3 days

---

## Recommendation: Hybrid Approach

### Phase 1: Database + File Logging (Immediate)
1. Use `spawn()` instead of `exec()` for streaming
2. Store logs in files (PVC-mounted)
3. Store last 100 lines in DB
4. Add API endpoints for log viewing
5. **Time: 2-4 hours**

### Phase 2: Real-time Streaming (Next)
1. Add SSE endpoint for live logs
2. Update UI to stream logs
3. **Time: 2-3 hours**

### Phase 3: Background Worker (Optional)
1. Separate worker process
2. Simple DB-based queue
3. **Time: 4-6 hours**

### Phase 4: BullMQ (If Needed)
1. Add Redis
2. Migrate to BullMQ
3. Keep file logging
4. **Time: 1-2 days**

## Implementation Details

### Database Schema
```sql
-- Already created in migration 007
CREATE TABLE task_logs (
  task_id UUID,
  log_type VARCHAR(20), -- 'stdout' or 'stderr'
  line_number INTEGER,
  content TEXT,
  timestamp TIMESTAMP
);
```

### File Structure
```
/backups/
  ├── backups/          # Backup files (existing)
  └── logs/            # Task logs (new)
      ├── {taskId}.stdout.log
      └── {taskId}.stderr.log
```

### API Endpoints
```
GET  /api/tasks/[id]/logs          # Recent logs (DB, last 100 lines)
GET  /api/tasks/[id]/logs?full=true # Full log file
GET  /api/tasks/[id]/stream        # SSE stream (real-time)
POST /api/tasks/[id]/cancel        # Cancel task
```

### Usage Example
```typescript
// Create task
const task = await backupTaskService.createTask('backup', {...});

// Execute with streaming
await backupTaskStreamingService.executeBackupTaskStreaming(task.id, connString);

// View logs
const logs = await taskLoggerService.getRecentLogs(task.id);

// Stream logs (SSE)
const stream = taskLoggerService.streamLog(task.id, 'stdout');
for await (const chunk of stream) {
  console.log(chunk);
}
```

## Kubernetes Considerations

### PVC Setup
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: backup-storage
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
```

### Deployment
- Mount PVC at `/backups`
- Set `BACKUP_LOG_DIR=/backups/logs`
- Logs persist across pod restarts
- Easy to share between pods (ReadWriteMany if needed)

## Performance

### Database + File Approach
- **Task Creation:** < 10ms
- **Log Write:** < 5ms per line
- **Log Read (DB):** < 50ms (last 100 lines)
- **Log Read (File):** < 200ms (full file)
- **Streaming:** Real-time (500ms latency)

### Scalability
- **Concurrent Tasks:** Limited by Node.js event loop (typically 100+)
- **Log Storage:** Files scale better than DB
- **DB Size:** Minimal (only last 100 lines per task)

## Migration Path

1. **Start with Database + Files** (Phase 1)
2. **Add streaming** (Phase 2)
3. **Monitor performance**
4. **Add BullMQ if needed** (Phase 4)

This allows you to get fast results now, and scale later if needed.

