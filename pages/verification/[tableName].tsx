import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Navbar from '../../components/Navbar';
import { ArrowLeft, AlertCircle, CheckCircle, Clock, XCircle, Square, ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import { format } from 'date-fns';

interface VerificationDetails {
  job: {
    id: number;
    tableName: string;
    status: string;
    batchSize: number;
    cooldownMs: number;
    primaryKeyColumns: string[];
    startFromPkValue: string | null;
    lastCheckedPkValue: string | null;
    totalRowsChecked: string;
    mismatchesFound: number;
    gapsFound: number;
    startedAt: string;
    updatedAt: string;
    completedAt: string | null;
    errorMessage: string | null;
  };
  mismatches: Array<{
    id: number;
    primaryKeyValue: string;
    sourceRow: Record<string, any>;
    targetRow: Record<string, any>;
    detectedAt: string;
  }>;
  gaps: Array<{
    id: number;
    primaryKeyValue: string;
    sourceRow: Record<string, any>;
    detectedAt: string;
  }>;
  gapRanges: Array<{
    id: number;
    startPk: string;
    endPk: string;
    count: number;
    detectedAt: string;
    sampleSourceRow: Record<string, any>;
  }>;
  pagination: {
    limit: number;
    mismatchOffset: number;
    gapOffset: number;
    totalMismatches: number;
    totalGaps: number;
    gapLimitApplied?: number;
    gapLimitRequested?: number;
    gapLimitTruncated?: boolean;
  };
  timeline: {
    timestampColumn: string | null;
    buckets: Array<{
      hour: string;
      rowCount: number;
      mismatchCount: number;
      gapCount: number;
    }>;
    warnings: string[];
    hoursEvaluated: number;
  } | null;
}

type GapRecord = VerificationDetails['gaps'][number];

export default function VerificationDetail() {
  const router = useRouter();
  const { tableName } = router.query;
  const [details, setDetails] = useState<VerificationDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mismatchPage, setMismatchPage] = useState(0);
  const [expandedGapRanges, setExpandedGapRanges] = useState<Set<number>>(new Set());
  const [timelineHours, setTimelineHours] = useState(168);
  const [recheckingGaps, setRecheckingGaps] = useState(false);
  const [restoringGaps, setRestoringGaps] = useState(false);
  const [gapActionMessage, setGapActionMessage] = useState<string | null>(null);
  const [gapActionError, setGapActionError] = useState<string | null>(null);
  const ITEMS_PER_PAGE = 100;

  useEffect(() => {
    if (tableName) {
      fetchDetails();
      const interval = setInterval(fetchDetails, 5000); // Refresh every 5 seconds
      return () => clearInterval(interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableName, mismatchPage, timelineHours]);

  const fetchDetails = async () => {
    try {
      const mismatchOffset = mismatchPage * ITEMS_PER_PAGE;
      const params = new URLSearchParams({
        mismatchOffset: mismatchOffset.toString(),
        gapOffset: '0',
        limit: ITEMS_PER_PAGE.toString(),
        gapLimit: '10000',
        timelineHours: timelineHours.toString(),
      });
      const response = await fetch(`/api/verification/${tableName}?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch verification details');
      }
      const data = await response.json();
      setDetails(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRecheckGaps = async () => {
    if (!tableName) return;
    setRecheckingGaps(true);
    setGapActionError(null);
    try {
      const response = await fetch(`/api/verification/${tableName}/recheck-gaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 10000 }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || 'Failed to re-check gaps');
      }
      const result = await response.json();
      setGapActionMessage(
        `Rechecked ${result.rechecked.toLocaleString()} gap(s), resolved ${result.resolved.toLocaleString()}`
      );
      await fetchDetails();
    } catch (err: any) {
      setGapActionError(err.message || 'Failed to re-check gaps');
    } finally {
      setRecheckingGaps(false);
    }
  };

  const handleRestoreGaps = async () => {
    if (!tableName || !details?.job?.id) return;
    if (!confirm('Are you sure you want to restore all missing gaps? This will insert missing rows into the target database.')) return;

    setRestoringGaps(true);
    setGapActionError(null);
    try {
      const response = await fetch('/api/verification/restore-gaps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: details.job.id }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.message || 'Failed to restore gaps');
      }

      const result = await response.json();

      if (result.errors > 0) {
        const errorDetails = result.errorMessages && result.errorMessages.length > 0
          ? `\n\nDetails:\n${result.errorMessages.join('\n')}`
          : '';

        setGapActionError(
          `Restored ${result.restored.toLocaleString()} gap(s), but encountered ${result.errors} error(s).${errorDetails}`
        );
      } else {
        setGapActionMessage(
          `Successfully restored ${result.restored.toLocaleString()} gap(s).`
        );
      }

      await fetchDetails();
    } catch (err: any) {
      setGapActionError(err.message || 'Failed to restore gaps');
    } finally {
      setRestoringGaps(false);
    }
  };

  const formatNumber = (num: string | number) => {
    return parseInt(num.toString()).toLocaleString();
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString();
  };

  const formatHourLabel = (iso: string) => {
    return format(new Date(iso), 'MMM d HH:mm');
  };

  const toDateFromEpoch = (value: any): Date | null => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const num = typeof value === 'string' ? Number(value) : Number(value);
    if (!Number.isFinite(num)) {
      return null;
    }
    // Assume values larger than unix millis threshold are already in ms
    if (Math.abs(num) > 1e12) {
      return new Date(num);
    }
    return new Date(num * 1000);
  };

  const extractGapTimestamp = (gap: { sourceRow: Record<string, any>; detectedAt: string }): Date => {
    const row = gap.sourceRow || {};
    const candidateKeys = [
      'block_timestamp',
      'blockTimestamp',
      'timestamp',
      'event_timestamp',
      'created_at',
      'createdAt',
    ];

    for (const key of candidateKeys) {
      if (row[key] !== undefined) {
        if (typeof row[key] === 'string' || typeof row[key] === 'number') {
          const maybeDate = toDateFromEpoch(row[key]);
          if (maybeDate) {
            return maybeDate;
          }
        } else {
          const date = new Date(row[key]);
          if (!isNaN(date.getTime())) {
            return date;
          }
        }
      }
    }

    return new Date(gap.detectedAt);
  };

  const TimelineTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || payload.length === 0) {
      return null;
    }
    const bucket = payload[0].payload;
    return (
      <div className="bg-white border border-gray-200 rounded-md shadow text-sm p-3">
        <div className="font-semibold text-gray-900">{formatHourLabel(label as string)}</div>
        <div className="mt-1 text-gray-700">
          Rows: <span className="font-medium">{bucket.rowCount.toLocaleString()}</span>
        </div>
        <div className="text-yellow-700">
          Gaps: <span className="font-medium">{bucket.gapCount}</span>
        </div>
        <div className="text-red-700">
          Mismatches: <span className="font-medium">{bucket.mismatchCount}</span>
        </div>
      </div>
    );
  };

  const gapHistogramData = useMemo(() => {
    if (!details) return null;
    if ((details.pagination?.totalGaps || 0) > 10000) {
      return null;
    }
    if (!details.gaps || details.gaps.length === 0) {
      return null;
    }

    const buckets = new Map<string, { count: number; date: Date }>();

    for (const gap of details.gaps) {
      const date = extractGapTimestamp(gap);
      if (!date || isNaN(date.getTime())) continue;
      const bucketDate = new Date(date);
      bucketDate.setMinutes(0, 0, 0);
      const iso = bucketDate.toISOString();
      const existing = buckets.get(iso);
      if (existing) {
        existing.count += 1;
      } else {
        buckets.set(iso, { count: 1, date: bucketDate });
      }
    }

    return Array.from(buckets.entries())
      .map(([iso, info]) => ({
        iso,
        hourLabel: format(info.date, 'MMM d HH:00'),
        count: info.count,
      }))
      .sort((a, b) => new Date(a.iso).getTime() - new Date(b.iso).getTime());
  }, [details]);

  const normalizedGapRanges = useMemo(() => {
    if (!details) return [];
    if (details.gapRanges && details.gapRanges.length > 0) {
      return details.gapRanges.map(range => ({
        id: range.id,
        startPk: range.startPk,
        endPk: range.endPk,
        count: range.count,
        detectedAt: range.detectedAt,
        sampleRow: range.sampleSourceRow,
        gaps: [] as GapRecord[],
      }));
    }
    if (!details.gaps) return [];
    return groupGapsIntoRanges(details.gaps).map(range => ({
      id: range.id,
      startPk: range.startPk,
      endPk: range.endPk,
      count: range.count,
      detectedAt: range.detectedAt,
      sampleRow: range.gaps[0]?.sourceRow ?? {},
      gaps: range.gaps,
    }));
  }, [details]);

  const totalGapRows =
    details?.pagination?.totalGaps ??
    normalizedGapRanges.reduce((sum, range) => sum + range.count, 0);
  const largestGapRange = normalizedGapRanges.reduce(
    (max, range) => Math.max(max, range.count),
    0
  );

  const timelineRangeOptions = [
    { label: 'Last 24h', value: 24 },
    { label: 'Last 72h', value: 72 },
    { label: 'Last 7d', value: 168 },
  ];

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <Clock className="w-6 h-6 text-blue-500 animate-spin" />;
      case 'completed':
        return <CheckCircle className="w-6 h-6 text-green-500" />;
      case 'stopped':
        return <Square className="w-6 h-6 text-yellow-500" />;
      case 'error':
        return <XCircle className="w-6 h-6 text-red-500" />;
      default:
        return <AlertCircle className="w-6 h-6 text-gray-500" />;
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

  const renderJSON = (obj: Record<string, any>) => {
    return (
      <pre className="bg-gray-50 p-3 rounded text-xs overflow-x-auto">
        {JSON.stringify(obj, null, 2)}
      </pre>
    );
  };

  // Group consecutive gaps into ranges
  const groupGapsIntoRanges = (gaps: Array<{ id: number; primaryKeyValue: string; sourceRow: Record<string, any>; detectedAt: string }>) => {
    if (gaps.length === 0) return [];

    const sortedGaps = [...gaps].sort((a, b) => {
      try {
        const aPk = BigInt(a.primaryKeyValue);
        const bPk = BigInt(b.primaryKeyValue);
        if (aPk < bPk) return -1;
        if (aPk > bPk) return 1;
        return 0;
      } catch {
        return a.primaryKeyValue.localeCompare(b.primaryKeyValue);
      }
    });

    const ranges: Array<{
      id: number;
      startPk: string;
      endPk: string;
      count: number;
      gaps: typeof sortedGaps;
      detectedAt: string;
    }> = [];

    let currentRange = {
      id: 0,
      startPk: sortedGaps[0].primaryKeyValue,
      endPk: sortedGaps[0].primaryKeyValue,
      count: 1,
      gaps: [sortedGaps[0]],
      detectedAt: sortedGaps[0].detectedAt,
    };

    for (let i = 1; i < sortedGaps.length; i++) {
      let isSequential = false;
      try {
        const prevPk = BigInt(sortedGaps[i - 1].primaryKeyValue);
        const currPk = BigInt(sortedGaps[i].primaryKeyValue);
        isSequential = currPk === prevPk + BigInt(1);
      } catch {
        isSequential = false;
      }

      // If consecutive (difference of 1), add to current range
      if (isSequential) {
        currentRange.endPk = sortedGaps[i].primaryKeyValue;
        currentRange.count++;
        currentRange.gaps.push(sortedGaps[i]);
      } else {
        // Save current range and start new one
        ranges.push({ ...currentRange, id: ranges.length });
        currentRange = {
          id: ranges.length,
          startPk: sortedGaps[i].primaryKeyValue,
          endPk: sortedGaps[i].primaryKeyValue,
          count: 1,
          gaps: [sortedGaps[i]],
          detectedAt: sortedGaps[i].detectedAt,
        };
      }
    }

    // Add the last range
    ranges.push({ ...currentRange, id: ranges.length });

    return ranges;
  };

  const toggleGapRange = (rangeId: number) => {
    setExpandedGapRanges(prev => {
      const newSet = new Set(prev);
      if (newSet.has(rangeId)) {
        newSet.delete(rangeId);
      } else {
        newSet.add(rangeId);
      }
      return newSet;
    });
  };

  const PaginationControls = ({
    currentPage,
    totalItems,
    onPageChange
  }: {
    currentPage: number;
    totalItems: number;
    onPageChange: (page: number) => void;
  }) => {
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
    const startItem = currentPage * ITEMS_PER_PAGE + 1;
    const endItem = Math.min((currentPage + 1) * ITEMS_PER_PAGE, totalItems);

    if (totalPages <= 1) return null;

    return (
      <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
        <div className="text-sm text-gray-600">
          Showing {startItem}-{endItem} of {totalItems}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage === 0}
            className="px-3 py-1 rounded border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <ChevronLeft className="w-4 h-4" />
            Previous
          </button>
          <span className="text-sm text-gray-600">
            Page {currentPage + 1} of {totalPages}
          </span>
          <button
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages - 1}
            className="px-3 py-1 rounded border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="text-center py-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <p className="mt-2 text-gray-600">Loading verification details...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6">
            <p className="text-red-800">{error || 'Verification not found'}</p>
            <Link href="/verification" className="text-blue-600 hover:underline mt-2 inline-block">
              ← Back to Verifications
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const { job, mismatches, gaps, pagination, timeline } = details;

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-6">
          <Link href="/verification" className="text-blue-600 hover:underline flex items-center mb-4">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Verifications
          </Link>
          <div className="flex items-center space-x-3">
            {getStatusIcon(job.status)}
            <h1 className="text-3xl font-bold text-gray-900">{job.tableName}</h1>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(job.status)}`}>
              {job.status.toUpperCase()}
            </span>
          </div>
        </div>

        {/* Overview Card */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Overview</h2>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <p className="text-sm text-gray-600 mb-1">Total Rows Checked</p>
              <p className="text-2xl font-bold text-gray-900">{formatNumber(job.totalRowsChecked)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600 mb-1">Mismatches Found</p>
              <p className="text-2xl font-bold text-red-600">{job.mismatchesFound}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600 mb-1">Gaps Found</p>
              <p className="text-2xl font-bold text-yellow-600">{job.gapsFound}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600 mb-1">Primary Key</p>
              <p className="text-2xl font-bold text-gray-900">
                {job.primaryKeyColumns.length > 1
                  ? `(${job.primaryKeyColumns.join(', ')})`
                  : job.primaryKeyColumns[0]}
              </p>
            </div>
          </div>

          <div className="mt-6 pt-6 border-t border-gray-200">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              {/* Row 1: Timestamps and Last Checked PK */}
              <div>
                <span className="font-medium text-gray-700">Started:</span>
                <span className="ml-2 text-gray-600">{formatDate(job.startedAt)}</span>
              </div>
              <div>
                <span className="font-medium text-gray-700">Last Updated:</span>
                <span className="ml-2 text-gray-600">{formatDate(job.updatedAt)}</span>
              </div>
              <div>
                <span className="font-medium text-gray-700">Completed:</span>
                <span className="ml-2 text-gray-600">{job.completedAt ? formatDate(job.completedAt) : 'N/A'}</span>
              </div>
              <div>
                <span className="font-medium text-gray-700">Last Checked PK:</span>
                <span className="ml-2 text-gray-600">{job.lastCheckedPkValue || 'N/A'}</span>
              </div>

              {/* Row 2: Configuration values */}
              <div>
                <span className="font-medium text-gray-700">Batch Size:</span>
                <span className="ml-2 text-gray-600">{job.batchSize} rows</span>
              </div>
              <div>
                <span className="font-medium text-gray-700">Cooldown:</span>
                <span className="ml-2 text-gray-600">{job.cooldownMs}ms</span>
              </div>
              <div>
                <span className="font-medium text-gray-700">Start From:</span>
                <span className="ml-2 text-gray-600">{job.startFromPkValue || 'beginning'}</span>
              </div>
            </div>
          </div>

          {job.errorMessage && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded">
              <p className="text-sm text-red-800">
                <span className="font-medium">Error:</span> {job.errorMessage}
              </p>
            </div>
          )}
        </div>

        {timeline && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Hourly Timeline</h2>
                <p className="text-sm text-gray-600">
                  {timeline.timestampColumn
                    ? <>Bucketed by <code className="px-1 bg-gray-100 rounded">{timeline.timestampColumn}</code> ({timeline.hoursEvaluated}h window)</>
                    : 'No timestamp column detected'}
                </p>
              </div>
              <div className="flex items-center space-x-2">
                <label className="text-sm text-gray-600">Range:</label>
                <select
                  value={timelineHours}
                  onChange={(e) => setTimelineHours(parseInt(e.target.value))}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {timelineRangeOptions.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {timeline.timestampColumn ? (
              timeline.buckets.length > 0 ? (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <div className="p-4 bg-gray-50 rounded-lg">
                      <p className="text-sm text-gray-600">Total Rows</p>
                      <p className="text-2xl font-semibold text-gray-900">
                        {timeline.buckets.reduce((sum, bucket) => sum + bucket.rowCount, 0).toLocaleString()}
                      </p>
                    </div>
                    <div className="p-4 bg-gray-50 rounded-lg">
                      <p className="text-sm text-gray-600">Hours with Gaps</p>
                      <p className="text-2xl font-semibold text-yellow-600">
                        {timeline.buckets.filter(bucket => bucket.gapCount > 0).length}
                      </p>
                    </div>
                    <div className="p-4 bg-gray-50 rounded-lg">
                      <p className="text-sm text-gray-600">Hours with Mismatches</p>
                      <p className="text-2xl font-semibold text-red-600">
                        {timeline.buckets.filter(bucket => bucket.mismatchCount > 0).length}
                      </p>
                    </div>
                  </div>

                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={timeline.buckets} margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis
                          dataKey="hour"
                          tickFormatter={(value) => format(new Date(value), 'MM/dd HH:mm')}
                          minTickGap={16}
                        />
                        <YAxis />
                        <Tooltip content={<TimelineTooltip />} />
                        <Bar dataKey="rowCount" name="Rows / hour" radius={[4, 4, 0, 0]}>
                          {timeline.buckets.map((bucket, index) => {
                            let fill = '#2563eb';
                            if (bucket.mismatchCount > 0) {
                              fill = '#dc2626';
                            } else if (bucket.gapCount > 0) {
                              fill = '#f59e0b';
                            }
                            return <Cell key={`cell-${bucket.hour}-${index}`} fill={fill} />;
                          })}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : (
                <div className="p-6 text-center text-gray-600 border border-dashed border-gray-200 rounded-lg">
                  No rows found in the selected time range.
                </div>
              )
            ) : (
              <div className="p-6 bg-yellow-50 border border-yellow-200 rounded">
                <p className="text-sm text-yellow-800">
                  Unable to detect a timestamp column automatically. Run <code>scripts/analyze-table-timestamps.sh</code> to identify candidates.
                </p>
              </div>
            )}

            {timeline.warnings.length > 0 && (
              <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded">
                <p className="text-sm font-medium text-yellow-800 mb-2">Warnings</p>
                <ul className="list-disc list-inside text-sm text-yellow-900 space-y-1">
                  {timeline.warnings.map((warning, idx) => (
                    <li key={idx}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Mismatches Section */}
        {mismatches.length > 0 && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
              <AlertCircle className="w-5 h-5 text-red-500 mr-2" />
              Mismatches ({pagination.totalMismatches})
            </h2>

            <div className="space-y-4">
              {mismatches.map(mismatch => (
                <div key={mismatch.id} className="border border-red-200 rounded-lg p-4 bg-red-50">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <span className="font-medium text-gray-900">PK: {mismatch.primaryKeyValue}</span>
                      <span className="ml-4 text-sm text-gray-600">
                        Detected: {formatDate(mismatch.detectedAt)}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">Source Row:</p>
                      {renderJSON(mismatch.sourceRow)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">Target Row:</p>
                      {renderJSON(mismatch.targetRow)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <PaginationControls
              currentPage={mismatchPage}
              totalItems={pagination.totalMismatches}
              onPageChange={setMismatchPage}
            />
          </div>
        )}

        {/* Gaps Section - Range View */}
        {gaps.length > 0 && (
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
              <h2 className="text-lg font-semibold text-gray-900 flex items-center">
                <AlertCircle className="w-5 h-5 text-yellow-500 mr-2" />
                Gaps ({pagination.totalGaps})
              </h2>
              <div className="flex gap-2">
                <button
                  onClick={handleRecheckGaps}
                  disabled={recheckingGaps}
                  className="inline-flex items-center px-4 py-2 border border-yellow-300 text-sm font-medium rounded-md text-yellow-800 bg-yellow-50 hover:bg-yellow-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {recheckingGaps ? 'Re-checking…' : 'Re-check gaps'}
                </button>
                <button
                  onClick={handleRestoreGaps}
                  disabled={restoringGaps}
                  className="inline-flex items-center px-4 py-2 border border-green-300 text-sm font-medium rounded-md text-green-800 bg-green-50 hover:bg-green-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {restoringGaps ? 'Restoring…' : 'Restore Gaps'}
                </button>
              </div>
            </div>
            {gapActionMessage && (
              <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded p-3">
                {gapActionMessage}
              </div>
            )}
            {gapActionError && (
              <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
                {gapActionError}
              </div>
            )}

            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="font-medium text-gray-700">Total Missing:</span>
                  <span className="ml-2 text-gray-900">{totalGapRows} rows</span>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Gap Ranges:</span>
                  <span className="ml-2 text-gray-900">{normalizedGapRanges.length}</span>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Largest Range:</span>
                  <span className="ml-2 text-gray-900">
                    {largestGapRange.toLocaleString()} rows
                  </span>
                </div>
              </div>
              {pagination.gapLimitTruncated && (
                <p className="mt-3 text-xs text-yellow-800">
                  Showing first {pagination.gapLimitApplied?.toLocaleString() || gapHistogramData?.length || '2k'} gaps (requested {pagination.gapLimitRequested?.toLocaleString() || '—'}).
                  Download raw data from the monitoring DB if you need the complete set.
                </p>
              )}
            </div>

            {gapHistogramData && (
              <div className="mb-6">
                <h3 className="text-sm font-semibold text-gray-800 mb-2">Gap Event Histogram (hourly)</h3>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={gapHistogramData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="hourLabel"
                        angle={-45}
                        textAnchor="end"
                        height={60}
                        interval={Math.ceil(gapHistogramData.length / 12)}
                      />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="count" fill="#fbbf24" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Showing individual events because total gaps ≤ 10,000. Larger tables fall back to aggregated hourly buckets.
                </p>
              </div>
            )}

            <div className="space-y-3">
              {normalizedGapRanges.map(range => (
                <div key={range.id} className="border border-yellow-200 rounded-lg bg-yellow-50">
                  <div
                    className="p-4 cursor-pointer hover:bg-yellow-100 transition-colors"
                    onClick={() => toggleGapRange(range.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-4">
                        {expandedGapRanges.has(range.id) ? (
                          <ChevronDown className="w-5 h-5 text-yellow-600" />
                        ) : (
                          <ChevronUp className="w-5 h-5 text-yellow-600" />
                        )}
                        <div>
                          <span className="font-semibold text-gray-900">
                            {range.count === 1 ? (
                              `PK: ${range.startPk}`
                            ) : (
                              `PK Range: ${range.startPk} → ${range.endPk}`
                            )}
                          </span>
                          <span className="ml-3 text-sm text-gray-600">
                            ({range.count} {range.count === 1 ? 'row' : 'rows'} missing)
                          </span>
                        </div>
                      </div>
                      <div className="text-sm text-gray-600">
                        {formatDate(range.detectedAt)}
                      </div>
                    </div>
                  </div>

                  {expandedGapRanges.has(range.id) && (
                    <div className="border-t border-yellow-200 p-4 bg-white space-y-3">
                      <div>
                        <p className="text-xs font-medium text-gray-700 mb-1">Sample Source Row</p>
                        {renderJSON(range.sampleRow)}
                      </div>
                      {range.gaps && range.gaps.length > 0 && (
                        <div className="space-y-3">
                          {range.gaps.map((gap, idx) => (
                            <div key={gap.id} className="border-l-4 border-yellow-400 pl-4">
                              <div className="mb-2">
                                <span className="font-medium text-gray-900">PK: {gap.primaryKeyValue}</span>
                                {range.count > 1 && (
                                  <span className="ml-2 text-xs text-gray-500">
                                    ({idx + 1} of {range.count})
                                  </span>
                                )}
                              </div>
                              <p className="text-xs font-medium text-gray-700 mb-1">Source Row (Missing in Target):</p>
                              {renderJSON(gap.sourceRow)}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No Issues */}
        {mismatches.length === 0 && gaps.length === 0 && job.status === 'completed' && (
          <div className="bg-white rounded-lg shadow p-12 text-center">
            <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-gray-900 mb-2">No Issues Found</h3>
            <p className="text-gray-600">
              All {formatNumber(job.totalRowsChecked)} rows match perfectly between source and target!
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
