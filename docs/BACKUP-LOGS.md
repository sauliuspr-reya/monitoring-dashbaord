# Backup Task Logs

## Log Storage Location

Backup task logs are stored in:
- **Default**: `/tmp/backup-logs/`
- **Custom**: Set `BACKUP_LOG_DIR` environment variable to change location

Log files are named:
- `${taskId}.stdout.log` - Standard output
- `${taskId}.stderr.log` - Standard error

## Viewing Logs

### In the UI

1. Go to **Backup & Restore** page
2. Find your backup task in the **Jobs** list
3. Click **"View Logs"** button on the task
4. The log viewer will show:
   - Recent logs from database (fast access)
   - Full logs from file (when downloading)
   - Real-time streaming for running tasks

### Via File System

```bash
# List all log files
ls -lh /tmp/backup-logs/

# View stdout for a specific task
cat /tmp/backup-logs/{taskId}.stdout.log

# View stderr for a specific task
cat /tmp/backup-logs/{taskId}.stderr.log

# Follow logs in real-time (for running tasks)
tail -f /tmp/backup-logs/{taskId}.stdout.log
```

### Via API

```bash
# Get recent logs (from database, last 100 lines)
curl http://localhost:3000/api/tasks/{taskId}/logs?type=stdout&limit=100

# Get full log file
curl http://localhost:3000/api/tasks/{taskId}/logs?type=stdout&full=true

# Stream logs (SSE)
curl -N http://localhost:3000/api/tasks/{taskId}/stream?type=stdout
```

## Log Content

### What Gets Logged

1. **Initial messages**:
   - Backup start notification
   - Table count information
   - Command details

2. **pg_dump output** (with `--verbose` flag):
   - Progress messages
   - Table dump progress
   - Warnings and notices

3. **Completion messages**:
   - Exit code
   - File size
   - Success/failure status

### Note on pg_dump Output

When `pg_dump` uses the `-f` flag to write directly to a file, it produces minimal stdout/stderr output. The `--verbose` flag has been added to capture more progress information.

## Troubleshooting

### Logs Not Showing in UI

1. **Check if logs exist**:
   ```bash
   ls -la /tmp/backup-logs/{taskId}.*.log
   ```

2. **Check database**:
   ```sql
   SELECT * FROM task_logs WHERE task_id = '{taskId}' ORDER BY line_number;
   ```

3. **Check browser console** for API errors

4. **Verify task ID** matches the log file names

### Empty Logs

If logs appear empty:
- `pg_dump` with `-f` writes directly to file, minimal stdout/stderr
- Check stderr for errors
- Check if backup completed successfully
- Look for completion messages in stdout

### Log Files Not Created

1. **Check permissions**:
   ```bash
   ls -ld /tmp/backup-logs
   ```

2. **Check environment variable**:
   ```bash
   echo $BACKUP_LOG_DIR
   ```

3. **Check application logs** for errors during log initialization

## Log Retention

- Logs are kept in the database (last 100 lines per log type)
- Full logs are kept in files indefinitely (unless manually deleted)
- Use `taskLoggerService.cleanupOldLogs(days)` to clean up old files

## Database Schema

Logs are stored in two places:

1. **`task_logs` table** (recent logs, fast access):
   - `task_id` - Task identifier
   - `log_type` - 'stdout' or 'stderr'
   - `line_number` - Line number
   - `content` - Log line content
   - `timestamp` - When logged

2. **`backup_tasks` table** (metadata):
   - `log_filepath` - Path to stdout log file
   - `stdout_lines` - Number of stdout lines
   - `stderr_lines` - Number of stderr lines

