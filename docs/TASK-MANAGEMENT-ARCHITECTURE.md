# Task Management Architecture

## Current State

### Problems
1. **No stdout/stderr capture**: Output from `pg_dump`, `pg_restore`, `psql` is lost
2. **No real-time progress**: Users can't see what's happening during execution
3. **No log history**: Can't debug failed tasks or review successful ones
4. **Blocking operations**: Long-running tasks could block the API server
5. **No task queue**: Tasks run immediately, no prioritization or rate limiting

### Current Implementation
- Tasks stored in `backup_tasks` table
- Execution via `child_process.exec()` (promisified)
- Status updates in DB
- Background execution (fire-and-forget)

## Solution Options

### Option 1: Database + File Logging (Recommended for Fast Results)
**Pros:**
- ✅ Simple, uses existing infrastructure
- ✅ Fast to implement
- ✅ No additional services needed
- ✅ Works well with Kubernetes (PVC for logs)
- ✅ Can stream via SSE/WebSockets

**Cons:**
- ⚠️ Large logs could bloat DB (use files for full logs, DB for summaries)
- ⚠️ File cleanup needed

**Architecture:**
```
Task Creation → DB (status: pending)
     ↓
Background Worker → spawn() with streaming
     ↓
Real-time: stdout/stderr → File + DB (last N lines)
     ↓
Status Updates → DB
     ↓
UI: Poll DB + Stream logs via SSE
```

### Option 2: BullMQ + Redis
**Pros:**
- ✅ Professional job queue
- ✅ Built-in retry, prioritization
- ✅ Job progress tracking
- ✅ Can store output in Redis

**Cons:**
- ❌ Requires Redis infrastructure
- ❌ More complex setup
- ❌ Additional dependency

### Option 3: Kubernetes Jobs
**Pros:**
- ✅ Process isolation
- ✅ Resource limits
- ✅ Auto-restart on failure

**Cons:**
- ❌ PVC sharing complexity
- ❌ Harder to stream logs
- ❌ More complex deployment

## Recommended Solution: Hybrid Approach

### Architecture

1. **Task Storage**: PostgreSQL `backup_tasks` table (existing)
2. **Log Storage**: 
   - **Full logs**: Files in `/backups/logs/{taskId}.log`
   - **Summary**: Last 100 lines in DB `task_logs` table
3. **Execution**: Node.js `spawn()` with streaming
4. **Real-time Updates**: Server-Sent Events (SSE) or WebSockets
5. **Background Worker**: Separate worker process or in-process queue

### Database Schema

```sql
-- Task logs table (stores last N lines for quick access)
CREATE TABLE task_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES backup_tasks(id) ON DELETE CASCADE,
  log_type VARCHAR(20) NOT NULL, -- 'stdout' or 'stderr'
  line_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW(),
  UNIQUE(task_id, log_type, line_number)
);

CREATE INDEX idx_task_logs_task_id ON task_logs(task_id, timestamp DESC);
CREATE INDEX idx_task_logs_recent ON task_logs(task_id, line_number DESC) WHERE line_number > (SELECT MAX(line_number) - 100 FROM task_logs WHERE task_id = task_logs.task_id);

-- Add log_filepath to backup_tasks
ALTER TABLE backup_tasks ADD COLUMN IF NOT EXISTS log_filepath TEXT;
ALTER TABLE backup_tasks ADD COLUMN IF NOT EXISTS stdout_lines INTEGER DEFAULT 0;
ALTER TABLE backup_tasks ADD COLUMN IF NOT EXISTS stderr_lines INTEGER DEFAULT 0;
```

### Implementation Plan

#### Phase 1: Log Capture (Fast Implementation)
1. Modify `executeBackupTask` and `executeRestoreTask` to use `spawn()` instead of `exec()`
2. Stream stdout/stderr to files
3. Store last 100 lines in DB for quick access
4. Update status in real-time

#### Phase 2: Real-time Streaming
1. Add SSE endpoint `/api/tasks/[id]/stream`
2. Stream logs as they're written
3. Update UI to use SSE for live updates

#### Phase 3: Background Worker (Optional)
1. Separate worker process for task execution
2. Task queue in DB (simple SELECT ... WHERE status = 'pending' ORDER BY created_at)
3. Worker polls for pending tasks

### File Structure

```
/backups/
  ├── backups/          # Backup files
  └── logs/            # Task logs
      ├── {taskId}.stdout.log
      └── {taskId}.stderr.log
```

### API Endpoints

```
GET  /api/tasks/[id]/logs          # Get recent logs (from DB, last 100 lines)
GET  /api/tasks/[id]/logs/full     # Get full log file
GET  /api/tasks/[id]/stream        # SSE stream for real-time logs
POST /api/tasks/[id]/cancel        # Cancel running task
```

### Benefits

1. **Fast Results**: Uses existing DB, minimal changes
2. **Real-time Updates**: SSE for live progress
3. **Full History**: Files store complete logs
4. **Quick Access**: DB stores recent lines for UI
5. **Kubernetes Friendly**: Files in PVC, DB for metadata
6. **Scalable**: Can add Redis/BullMQ later if needed

