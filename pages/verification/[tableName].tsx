import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Navbar from '../../components/Navbar';
import { ArrowLeft, AlertCircle, CheckCircle, Clock, XCircle, Square, ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';

interface VerificationDetails {
  job: {
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
  pagination: {
    limit: number;
    offset: number;
    totalMismatches: number;
    totalGaps: number;
  };
}

export default function VerificationDetail() {
  const router = useRouter();
  const { tableName } = router.query;
  const [details, setDetails] = useState<VerificationDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mismatchPage, setMismatchPage] = useState(0);
  const [expandedGapRanges, setExpandedGapRanges] = useState<Set<number>>(new Set());
  const ITEMS_PER_PAGE = 100;

  useEffect(() => {
    if (tableName) {
      fetchDetails();
      const interval = setInterval(fetchDetails, 5000); // Refresh every 5 seconds
      return () => clearInterval(interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableName, mismatchPage]);

  const fetchDetails = async () => {
    try {
      const mismatchOffset = mismatchPage * ITEMS_PER_PAGE;
      const response = await fetch(
        `/api/verification/${tableName}?mismatchOffset=${mismatchOffset}&gapOffset=0&limit=${ITEMS_PER_PAGE}&gapLimit=10000`
      );
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

  const formatNumber = (num: string | number) => {
    return parseInt(num.toString()).toLocaleString();
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString();
  };

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
    
    const sortedGaps = [...gaps].sort((a, b) => 
      parseInt(a.primaryKeyValue) - parseInt(b.primaryKeyValue)
    );
    
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
      const prevPk = parseInt(sortedGaps[i - 1].primaryKeyValue);
      const currPk = parseInt(sortedGaps[i].primaryKeyValue);
      
      // If consecutive (difference of 1), add to current range
      if (currPk === prevPk + 1) {
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

  const { job, mismatches, gaps, pagination } = details;

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
              <p className="text-2xl font-bold text-gray-900">{job.primaryKeyColumn}</p>
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
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
              <AlertCircle className="w-5 h-5 text-yellow-500 mr-2" />
              Gaps ({pagination.totalGaps})
            </h2>
            
            {(() => {
              const gapRanges = groupGapsIntoRanges(gaps);
              return (
                <>
                  {/* Summary Stats */}
                  <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                      <div>
                        <span className="font-medium text-gray-700">Total Missing:</span>
                        <span className="ml-2 text-gray-900">{pagination.totalGaps} rows</span>
                      </div>
                      <div>
                        <span className="font-medium text-gray-700">Gap Ranges:</span>
                        <span className="ml-2 text-gray-900">{gapRanges.length}</span>
                      </div>
                      <div>
                        <span className="font-medium text-gray-700">Largest Range:</span>
                        <span className="ml-2 text-gray-900">
                          {Math.max(...gapRanges.map(r => r.count))} rows
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Gap Ranges */}
                  <div className="space-y-3">
                    {gapRanges.map(range => (
                      <div key={range.id} className="border border-yellow-200 rounded-lg bg-yellow-50">
                        {/* Range Header - Always Visible */}
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

                        {/* Expanded Details */}
                        {expandedGapRanges.has(range.id) && (
                          <div className="border-t border-yellow-200 p-4 bg-white">
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
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
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
