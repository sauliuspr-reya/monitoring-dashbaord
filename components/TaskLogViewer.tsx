import { useState, useEffect, useRef } from 'react';

interface TaskLogEntry {
  id: string;
  task_id: string;
  log_type: 'stdout' | 'stderr';
  line_number: number;
  content: string;
  timestamp: Date;
}

interface TaskLogViewerProps {
  taskId: string;
  taskType: 'backup' | 'restore';
  isOpen: boolean;
  onClose: () => void;
}

export default function TaskLogViewer({ taskId, taskType, isOpen, onClose }: TaskLogViewerProps) {
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logType, setLogType] = useState<'stdout' | 'stderr'>('stdout');
  const [autoScroll, setAutoScroll] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Load initial logs
  useEffect(() => {
    if (!isOpen || !taskId) return;

    const loadLogs = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/tasks/${taskId}/logs?type=${logType}&limit=200`);
        if (!response.ok) {
          throw new Error('Failed to load logs');
        }
        const data = await response.json();
        setLogs(data.logs || []);
      } catch (err: any) {
        setError(err.message || 'Failed to load logs');
      } finally {
        setLoading(false);
      }
    };

    loadLogs();
  }, [isOpen, taskId, logType]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // SSE streaming for real-time updates
  useEffect(() => {
    if (!isOpen || !taskId || !streaming) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    const eventSource = new EventSource(`/api/tasks/${taskId}/stream?type=${logType}`);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'log') {
          // Parse the log content and add new lines
          const lines = data.content.split('\n').filter((l: string) => l.length > 0);
          setLogs(prev => {
            const newLogs = [...prev];
            let lastLineNumber = prev.length > 0 ? prev[prev.length - 1].line_number : 0;
            
            lines.forEach((line: string) => {
              lastLineNumber++;
              newLogs.push({
                id: `${taskId}-${logType}-${lastLineNumber}`,
                task_id: taskId,
                log_type: logType,
                line_number: lastLineNumber,
                content: line,
                timestamp: new Date(),
              });
            });
            
            // Keep only last 500 lines to prevent memory issues
            return newLogs.slice(-500);
          });
        } else if (data.type === 'closed') {
          eventSource.close();
          setStreaming(false);
        } else if (data.type === 'error') {
          setError(data.message || 'Streaming error');
          eventSource.close();
          setStreaming(false);
        }
      } catch (err) {
        console.error('Error parsing SSE message:', err);
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      setStreaming(false);
    };

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [isOpen, taskId, logType, streaming]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  if (!isOpen) return null;

  const handleDownload = async () => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/logs?type=${logType}&full=true`);
      if (!response.ok) throw new Error('Failed to download logs');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${taskType}-${taskId}-${logType}.log`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      alert(`Failed to download logs: ${err.message}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl h-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              {taskType === 'backup' ? 'Backup' : 'Restore'} Task Logs
            </h2>
            <p className="text-sm text-gray-500 mt-1">Task ID: <span className="font-mono">{taskId}</span></p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl font-bold"
          >
            ×
          </button>
        </div>

        {/* Controls */}
        <div className="px-6 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <label className="text-sm font-medium text-gray-700">Log Type:</label>
              <select
                value={logType}
                onChange={(e) => {
                  setLogType(e.target.value as 'stdout' | 'stderr');
                  setStreaming(false);
                }}
                className="border border-gray-300 rounded px-3 py-1 text-sm"
              >
                <option value="stdout">stdout</option>
                <option value="stderr">stderr</option>
              </select>
            </div>
            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm text-gray-700">Auto-scroll</span>
            </label>
            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={streaming}
                onChange={(e) => setStreaming(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm text-gray-700">Live streaming</span>
            </label>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleDownload}
              className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
            >
              Download Full Log
            </button>
            <button
              onClick={() => {
                setLogs([]);
                setError(null);
                setLoading(true);
                // Reload logs
                fetch(`/api/tasks/${taskId}/logs?type=${logType}&limit=200`)
                  .then(res => res.json())
                  .then(data => {
                    setLogs(data.logs || []);
                    setLoading(false);
                  })
                  .catch(err => {
                    setError(err.message);
                    setLoading(false);
                  });
              }}
              className="px-3 py-1.5 bg-gray-600 text-white rounded text-sm hover:bg-gray-700"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Log Content */}
        <div className="flex-1 overflow-auto bg-gray-900 p-4" ref={logContainerRef}>
          {loading && logs.length === 0 ? (
            <div className="text-gray-400 text-center py-8">Loading logs...</div>
          ) : error ? (
            <div className="text-red-400 text-center py-8">Error: {error}</div>
          ) : logs.length === 0 ? (
            <div className="text-gray-400 text-center py-8">No logs available</div>
          ) : (
            <div className="font-mono text-sm">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className={`mb-1 ${
                    log.log_type === 'stderr' ? 'text-red-400' : 'text-green-400'
                  }`}
                >
                  <span className="text-gray-500 mr-2">
                    [{log.line_number.toString().padStart(4, '0')}]
                  </span>
                  <span>{log.content}</span>
                </div>
              ))}
              {streaming && (
                <div className="text-yellow-400 animate-pulse">
                  <span className="text-gray-500 mr-2">[....]</span>
                  <span>Streaming...</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
          <div className="text-sm text-gray-600">
            {logs.length > 0 && (
              <>
                Showing {logs.length} lines
                {streaming && <span className="ml-2 text-green-600">● Live</span>}
              </>
            )}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600 text-white rounded text-sm hover:bg-gray-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

