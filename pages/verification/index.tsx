import { useState, useEffect } from 'react';
import Link from 'next/link';
import Navbar from '../../components/Navbar';
import { Play, Square, AlertCircle, CheckCircle, Clock, XCircle, Trash2 } from 'lucide-react';

interface VerificationJob {
  id: number;
  tableName: string;
  status: string;
  batchSize: number;
  cooldownMs: number;
  primaryKeyColumn: string;
  startFromPkValue: string | null;
  lastCheckedPkValue: string | null;
  totalRowsChecked: string;
  mismatchesFound: number;
  gapsFound: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export default function VerificationDashboard() {
  const [jobs, setJobs] = useState<VerificationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [showStartModal, setShowStartModal] = useState(false);
  const [selectedTable, setSelectedTable] = useState('');
  const [batchSize, setBatchSize] = useState(1000);
  const [cooldownMs, setCooldownMs] = useState(100);
  const [primaryKeyOverride, setPrimaryKeyOverride] = useState('');
  const [startFromPkValue, setStartFromPkValue] = useState('');
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState<number | null>(null);
  const [resuming, setResuming] = useState<number | null>(null);
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [resumeJob, setResumeJob] = useState<{ tableName: string; id: number; batchSize: number; cooldownMs: number } | null>(null);
  const [showStopModal, setShowStopModal] = useState(false);
  const [stopJob, setStopJob] = useState<{ tableName: string; id: number } | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteJob, setDeleteJob] = useState<{ tableName: string; id: number } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const fetchJobs = async () => {
    try {
      const response = await fetch('/api/verification/jobs');
      const data = await response.json();
      setJobs(data.jobs || []);
    } catch (error) {
      console.error('Failed to fetch jobs:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleStartVerification = async () => {
    if (!selectedTable) {
      alert('Please enter a table name');
      return;
    }

    setStarting(true);
    try {
      const response = await fetch('/api/verification/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tableName: selectedTable,
          batchSize,
          cooldownMs,
          primaryKeyColumn: primaryKeyOverride || undefined,
          startFromPkValue: startFromPkValue || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error || 'Failed to start verification');
        return;
      }

      setShowStartModal(false);
      setSelectedTable('');
      setPrimaryKeyOverride('');
      setStartFromPkValue('');
      await fetchJobs();
    } catch (error) {
      console.error('Failed to start verification:', error);
      alert('Failed to start verification');
    } finally {
      setStarting(false);
    }
  };

  const handleStopClick = (tableName: string, jobId: number) => {
    setStopJob({ tableName, id: jobId });
    setShowStopModal(true);
  };

  const handleStopVerification = async () => {
    if (!stopJob) return;

    setStopping(stopJob.id);
    try {
      const response = await fetch('/api/verification/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableName: stopJob.tableName }),
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error || 'Failed to stop verification');
        return;
      }

      setShowStopModal(false);
      setStopJob(null);
      await fetchJobs();
    } catch (error) {
      console.error('Failed to stop verification:', error);
      alert('Failed to stop verification');
    } finally {
      setStopping(null);
    }
  };

  const handleResumeClick = (job: VerificationJob) => {
    setResumeJob({
      tableName: job.tableName,
      id: job.id,
      batchSize: job.batchSize,
      cooldownMs: job.cooldownMs,
    });
    setShowResumeModal(true);
  };

  const handleResumeVerification = async () => {
    if (!resumeJob) return;

    setResuming(resumeJob.id);
    try {
      const response = await fetch('/api/verification/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tableName: resumeJob.tableName,
          batchSize: resumeJob.batchSize,
          cooldownMs: resumeJob.cooldownMs,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error || 'Failed to resume verification');
        return;
      }

      setShowResumeModal(false);
      setResumeJob(null);
      await fetchJobs();
    } catch (error) {
      console.error('Failed to resume verification:', error);
      alert('Failed to resume verification');
    } finally {
      setResuming(null);
    }
  };

  const handleDeleteClick = (tableName: string, jobId: number) => {
    setDeleteJob({ tableName, id: jobId });
    setShowDeleteModal(true);
  };

  const handleDeleteVerification = async () => {
    if (!deleteJob) return;

    setDeleting(deleteJob.id);
    try {
      const response = await fetch('/api/verification/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableName: deleteJob.tableName }),
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error || 'Failed to delete verification');
        return;
      }

      setShowDeleteModal(false);
      setDeleteJob(null);
      await fetchJobs();
    } catch (error) {
      console.error('Failed to delete verification:', error);
      alert('Failed to delete verification');
    } finally {
      setDeleting(null);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <Clock className="w-5 h-5 text-blue-500 animate-spin" />;
      case 'completed':
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'stopped':
        return <Square className="w-5 h-5 text-yellow-500" />;
      case 'error':
        return <XCircle className="w-5 h-5 text-red-500" />;
      default:
        return <AlertCircle className="w-5 h-5 text-gray-500" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'bg-blue-100 text-blue-800';
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'stopped':
        return 'bg-yellow-100 text-yellow-800';
      case 'error':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const formatNumber = (num: string | number) => {
    return parseInt(num.toString()).toLocaleString();
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString();
  };

  const runningJobs = jobs.filter(j => j.status === 'running');
  const completedJobs = jobs.filter(j => j.status === 'completed');
  const stoppedJobs = jobs.filter(j => j.status === 'stopped');
  const errorJobs = jobs.filter(j => j.status === 'error');

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Data Integrity Verification</h1>
          <p className="mt-2 text-gray-600">
            Compare source and target tables row-by-row to detect mismatches and gaps
          </p>
        </div>

        {/* Start Button */}
        <div className="mb-6">
          <button
            onClick={() => setShowStartModal(true)}
            className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            <Play className="w-4 h-4 mr-2" />
            Start New Verification
          </button>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Running</p>
                <p className="text-2xl font-bold text-blue-600">{runningJobs.length}</p>
              </div>
              <Clock className="w-8 h-8 text-blue-500" />
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Completed</p>
                <p className="text-2xl font-bold text-green-600">{completedJobs.length}</p>
              </div>
              <CheckCircle className="w-8 h-8 text-green-500" />
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Stopped</p>
                <p className="text-2xl font-bold text-yellow-600">{stoppedJobs.length}</p>
              </div>
              <Square className="w-8 h-8 text-yellow-500" />
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Errors</p>
                <p className="text-2xl font-bold text-red-600">{errorJobs.length}</p>
              </div>
              <XCircle className="w-8 h-8 text-red-500" />
            </div>
          </div>
        </div>

        {/* Jobs List */}
        {loading ? (
          <div className="text-center py-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <p className="mt-2 text-gray-600">Loading verifications...</p>
          </div>
        ) : jobs.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-12 text-center">
            <AlertCircle className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600">No verifications found</p>
            <p className="text-sm text-gray-500 mt-2">Click &quot;Start New Verification&quot; to begin</p>
          </div>
        ) : (
          <div className="space-y-4">
            {jobs.map(job => (
              <div key={job.id} className="bg-white rounded-lg shadow p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center space-x-3 mb-3">
                      {getStatusIcon(job.status)}
                      <h3 className="text-lg font-semibold text-gray-900">{job.tableName}</h3>
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(job.status)}`}>
                        {job.status.toUpperCase()}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                      <div>
                        <p className="text-sm text-gray-600">Rows Checked</p>
                        <p className="text-lg font-semibold text-gray-900">{formatNumber(job.totalRowsChecked)}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-600">Mismatches</p>
                        <p className="text-lg font-semibold text-red-600">{job.mismatchesFound}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-600">Gaps</p>
                        <p className="text-lg font-semibold text-yellow-600">{job.gapsFound}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-600">Primary Key</p>
                        <p className="text-lg font-semibold text-gray-900">{job.primaryKeyColumn}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm text-gray-600">
                      <div>
                        <span className="font-medium">Batch Size:</span> {job.batchSize} rows
                      </div>
                      <div>
                        <span className="font-medium">Cooldown:</span> {job.cooldownMs}ms
                      </div>
                      <div>
                        <span className="font-medium">Start From:</span> {job.startFromPkValue || 'beginning'}
                      </div>
                      <div>
                        <span className="font-medium">Started:</span> {formatDate(job.startedAt)}
                      </div>
                    </div>

                    {job.errorMessage && (
                      <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded">
                        <p className="text-sm text-red-800">
                          <span className="font-medium">Error:</span> {job.errorMessage}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col space-y-2 ml-4">
                    <Link
                      href={`/verification/${job.tableName}`}
                      className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                      View Details
                    </Link>
                    {job.status === 'running' && (
                      <button
                        onClick={() => handleStopClick(job.tableName, job.id)}
                        disabled={stopping === job.id}
                        className="inline-flex items-center px-3 py-2 border border-red-300 shadow-sm text-sm leading-4 font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                      >
                        <Square className="w-4 h-4 mr-1" />
                        {stopping === job.id ? 'Stopping...' : 'Stop'}
                      </button>
                    )}
                    {job.status === 'stopped' && (
                      <>
                        <button
                          onClick={() => handleResumeClick(job)}
                          disabled={resuming === job.id}
                          className="inline-flex items-center px-3 py-2 border border-green-300 shadow-sm text-sm leading-4 font-medium rounded-md text-green-700 bg-white hover:bg-green-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50"
                        >
                          <Play className="w-4 h-4 mr-1" />
                          {resuming === job.id ? 'Resuming...' : 'Resume'}
                        </button>
                        <button
                          onClick={() => handleDeleteClick(job.tableName, job.id)}
                          disabled={deleting === job.id}
                          className="inline-flex items-center px-3 py-2 border border-red-300 shadow-sm text-sm leading-4 font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                        >
                          <Trash2 className="w-4 h-4 mr-1" />
                          {deleting === job.id ? 'Deleting...' : 'Delete'}
                        </button>
                      </>
                    )}
                    {(job.status === 'completed' || job.status === 'error') && (
                      <button
                        onClick={() => handleDeleteClick(job.tableName, job.id)}
                        disabled={deleting === job.id}
                        className="inline-flex items-center px-3 py-2 border border-red-300 shadow-sm text-sm leading-4 font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        {deleting === job.id ? 'Deleting...' : 'Delete'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Start Verification Modal */}
      {showStartModal && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Start Data Integrity Verification</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Table Name
                </label>
                <input
                  type="text"
                  value={selectedTable}
                  onChange={(e) => setSelectedTable(e.target.value)}
                  placeholder="e.g., orders"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Primary Key Column <span className="text-gray-500 text-xs">(optional)</span>
                </label>
                <input
                  type="text"
                  value={primaryKeyOverride}
                  onChange={(e) => setPrimaryKeyOverride(e.target.value)}
                  placeholder="e.g., id (leave empty for auto-detect)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  If specified, this column will be used instead of auto-detection
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Start From Primary Key Value <span className="text-gray-500 text-xs">(optional)</span>
                </label>
                <input
                  type="text"
                  value={startFromPkValue}
                  onChange={(e) => setStartFromPkValue(e.target.value)}
                  placeholder="e.g., 15389 (leave empty to start from beginning)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Start verification from this primary key value onwards
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Batch Size (rows)
                </label>
                <input
                  type="number"
                  value={batchSize}
                  onChange={(e) => setBatchSize(parseInt(e.target.value))}
                  min="1"
                  max="10000"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Cooldown (ms)
                </label>
                <input
                  type="number"
                  value={cooldownMs}
                  onChange={(e) => setCooldownMs(parseInt(e.target.value))}
                  min="0"
                  max="5000"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
                <p className="text-sm text-yellow-800">
                  ⚠️ Only one verification can run at a time. Starting this will stop any active verification.
                </p>
              </div>
            </div>

            <div className="mt-6 flex space-x-3">
              <button
                onClick={() => {
                  setShowStartModal(false);
                  setPrimaryKeyOverride('');
                  setStartFromPkValue('');
                }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Cancel
              </button>
              <button
                onClick={handleStartVerification}
                disabled={starting || !selectedTable}
                className="flex-1 px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
              >
                {starting ? 'Starting...' : 'Start Verification'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resume Verification Modal */}
      {showResumeModal && resumeJob && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Resume Verification: {resumeJob.tableName}</h3>
            
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-md p-3 mb-4">
                <p className="text-sm text-blue-800">
                  <strong>Note:</strong> Verification will continue from where it stopped. You can adjust the batch size and cooldown below.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Batch Size (rows)
                </label>
                <input
                  type="number"
                  value={resumeJob.batchSize}
                  onChange={(e) => setResumeJob({ ...resumeJob, batchSize: parseInt(e.target.value) })}
                  min="1"
                  max="10000"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Cooldown (ms)
                </label>
                <input
                  type="number"
                  value={resumeJob.cooldownMs}
                  onChange={(e) => setResumeJob({ ...resumeJob, cooldownMs: parseInt(e.target.value) })}
                  min="0"
                  max="5000"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
            </div>

            <div className="mt-6 flex space-x-3">
              <button
                onClick={() => {
                  setShowResumeModal(false);
                  setResumeJob(null);
                }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
              >
                Cancel
              </button>
              <button
                onClick={handleResumeVerification}
                disabled={resuming === resumeJob.id}
                className="flex-1 px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50"
              >
                {resuming === resumeJob.id ? 'Resuming...' : 'Resume Verification'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stop Verification Modal */}
      {showStopModal && stopJob && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center mb-4">
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <Square className="w-6 h-6 text-red-600" />
              </div>
              <h3 className="ml-4 text-lg font-medium text-gray-900">Stop Verification</h3>
            </div>
            
            <div className="mb-6">
              <p className="text-sm text-gray-600 mb-3">
                Are you sure you want to stop the verification for <strong>{stopJob.tableName}</strong>?
              </p>
              <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
                <p className="text-sm text-yellow-800">
                  <strong>Note:</strong> The verification will be paused and can be resumed later from where it stopped.
                </p>
              </div>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => {
                  setShowStopModal(false);
                  setStopJob(null);
                }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
              >
                Cancel
              </button>
              <button
                onClick={handleStopVerification}
                disabled={stopping === stopJob.id}
                className="flex-1 px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
              >
                {stopping === stopJob.id ? 'Stopping...' : 'Stop Verification'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Verification Modal */}
      {showDeleteModal && deleteJob && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center mb-4">
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <Trash2 className="w-6 h-6 text-red-600" />
              </div>
              <h3 className="ml-4 text-lg font-medium text-gray-900">Delete Verification</h3>
            </div>
            
            <div className="mb-6">
              <p className="text-sm text-gray-600 mb-3">
                Are you sure you want to delete the verification for <strong>{deleteJob.tableName}</strong>?
              </p>
              <div className="bg-red-50 border border-red-200 rounded-md p-3">
                <p className="text-sm text-red-800">
                  <strong>Warning:</strong> This will permanently delete all verification data including mismatches and gaps. This action cannot be undone.
                </p>
              </div>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteJob(null);
                }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteVerification}
                disabled={deleting === deleteJob.id}
                className="flex-1 px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
              >
                {deleting === deleteJob.id ? 'Deleting...' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
