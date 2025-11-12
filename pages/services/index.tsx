import { useState, useEffect } from 'react';
import Navbar from '@/components/Navbar';
import Link from 'next/link';

interface ServiceWriteStats {
  applicationName: string;
  displayName?: string; // e.g., "Candles-GCP"
  originalApplicationName?: string; // Original name without suffix
  table: string;
  operation: string;
  count: number;
  lastWriteTime?: Date;
  username?: string;
  clientAddr?: string;
  databaseLocation?: DatabaseLocation;
}

interface DatabaseLocation {
  type: 'source' | 'target';
  provider: 'aws' | 'gcp' | 'unknown';
  host?: string;
  label: string;
}

interface ServiceWriteStatsWithLocation extends ServiceWriteStats {
  databaseLocation?: DatabaseLocation;
}

export default function ServicesPage() {
  const [writeStats, setWriteStats] = useState<ServiceWriteStatsWithLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState<number>(2);
  const [dataHours, setDataHours] = useState<number>(2);
  const [sourceLocation, setSourceLocation] = useState<DatabaseLocation | null>(null);
  const [targetLocation, setTargetLocation] = useState<DatabaseLocation | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'aws' | 'gcp'>('all');
  const [locationFilter, setLocationFilter] = useState<string>('all');
  const [selectedService, setSelectedService] = useState<string | null>(null);

  useEffect(() => {
    loadWriteStats();
    const interval = setInterval(loadWriteStats, 300000); // Refresh every 5 minutes
    return () => clearInterval(interval);
  }, [hours]);

  const loadWriteStats = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/services/write-stats?hours=${hours}&_t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        console.log('[Services] Received data:', {
          statsCount: data.stats?.length || 0,
          byApplicationCount: Object.keys(data.byApplication || {}).length,
          byApplicationKeys: Object.keys(data.byApplication || {}),
          sourceLocation: data.sourceLocation,
          targetLocation: data.targetLocation,
          hours: data.hours,
        });
        setWriteStats(data.stats || []);
        setDataHours(data.hours || hours);
        setSourceLocation(data.sourceLocation || null);
        setTargetLocation(data.targetLocation || null);
      } else {
        const errorText = await res.text();
        console.error('[Services] API error:', res.status, errorText);
      }
    } catch (error) {
      console.error('Error loading write stats:', error);
    } finally {
      setLoading(false);
    }
  };

  // Group by display name (ServiceName-Database) or application name
  // This creates separate entries for the same service writing to different databases
  const statsByService = writeStats.reduce((acc, stat) => {
    const serviceKey = stat.displayName || stat.applicationName;
    if (!acc[serviceKey]) {
      acc[serviceKey] = [];
    }
    acc[serviceKey].push(stat);
    return acc;
  }, {} as Record<string, ServiceWriteStatsWithLocation[]>);

  // Calculate summary stats for each service
  // Filter out placeholder entries (<no-recent-writes>) when counting, but keep services visible
  const serviceSummaries = Object.entries(statsByService).map(([serviceName, stats]) => {
    // Filter out placeholder entries for calculations
    const realStats = stats.filter(s => s.table !== '<no-recent-writes>');
    const totalWrites = realStats.reduce((sum, s) => sum + s.count, 0);
    const uniqueTables = new Set(realStats.map(s => s.table)).size;
    const operations = Array.from(new Set(realStats.map(s => s.operation)));
    const lastWriteTime = (() => {
      const times = realStats
        .map(s => s.lastWriteTime)
        .filter(Boolean)
        .map(time => typeof time === 'string' ? new Date(time) : (time instanceof Date ? time : new Date(time)));
      
      if (times.length === 0) return undefined;
      
      return times.sort((a, b) => {
        const aTime = a instanceof Date ? a.getTime() : 0;
        const bTime = b instanceof Date ? b.getTime() : 0;
        return bTime - aTime;
      })[0];
    })();
    
    // Collect unique usernames and IP addresses for this service (use all stats, including placeholders)
    const allUsernames = stats
      .map(s => s.username)
      .filter(Boolean)
      .flatMap(u => u?.split(',').map(v => v.trim()) || []);
    const allClientAddrs = stats
      .map(s => s.clientAddr)
      .filter(Boolean)
      .flatMap(ip => ip?.split(',').map(v => v.trim()) || []);
    const usernames = Array.from(new Set(allUsernames));
    const clientAddrs = Array.from(new Set(allClientAddrs));
    
    // Collect unique database locations for this service (use all stats, including placeholders)
    // Use a Map to deduplicate by provider+type to avoid showing multiple AWS/GCP labels
    const locationMap = new Map<string, typeof stats[0]['databaseLocation']>();
    for (const stat of stats) {
      if (stat.databaseLocation) {
        const key = `${stat.databaseLocation.provider}-${stat.databaseLocation.type}`;
        if (!locationMap.has(key)) {
          locationMap.set(key, stat.databaseLocation);
        }
      }
    }
    const databaseLocations = Array.from(locationMap.values());
    
    // Check if this is a placeholder service (no real writes)
    const isPlaceholder = realStats.length === 0 && stats.some(s => s.table === '<no-recent-writes>');
    
    return {
      serviceName,
      totalWrites,
      uniqueTables: isPlaceholder ? 0 : uniqueTables, // Show 0 for placeholder services
      operations: isPlaceholder ? [] : operations, // Show empty for placeholder services
      lastWriteTime,
      usernames,
      clientAddrs,
      databaseLocations, // Multiple locations if service writes to both
      databaseLocation: databaseLocations[0] || null, // Primary location for display
      stats: realStats.length > 0 ? realStats : stats, // Use real stats if available, otherwise show placeholder
      isPlaceholder, // Flag to indicate this is a placeholder service
    };
  }).sort((a, b) => {
    // Sort placeholder services last
    if (a.isPlaceholder && !b.isPlaceholder) return 1;
    if (!a.isPlaceholder && b.isPlaceholder) return -1;
    return b.totalWrites - a.totalWrites;
  });

  // Filter services by tab (AWS/GCP) - check all database locations for the service
  const filteredByTab = serviceSummaries.filter(summary => {
    if (activeTab === 'all') return true;
    // Check if service writes to the selected provider
    const hasProvider = summary.databaseLocations?.some(loc => {
      if (activeTab === 'aws') return loc?.provider === 'aws';
      if (activeTab === 'gcp') return loc?.provider === 'gcp';
      return false;
    });
    return hasProvider;
  });

  // Filter by location filter
  const filteredServices = filteredByTab.filter(summary => {
    if (locationFilter === 'all') return true;
    // Check if service writes to the selected location
    const matchesFilter = summary.databaseLocations?.some(loc => {
      if (locationFilter === 'source') return loc?.type === 'source';
      if (locationFilter === 'target') return loc?.type === 'target';
      if (locationFilter === 'aws') return loc?.provider === 'aws';
      if (locationFilter === 'gcp') return loc?.provider === 'gcp';
      return false;
    });
    return matchesFilter;
  });

  // Debug logging
  useEffect(() => {
    console.log('[Services] State:', {
      loading,
      writeStatsCount: writeStats.length,
      serviceSummariesCount: serviceSummaries.length,
      filteredServicesCount: filteredServices.length,
      sourceLocation,
      targetLocation,
      activeTab,
      locationFilter,
    });
  }, [loading, writeStats.length, serviceSummaries.length, filteredServices.length, sourceLocation, targetLocation, activeTab, locationFilter]);

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-gray-600">Loading...</div>
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="w-full px-6 sm:px-8 lg:px-12 py-8">
          <div className="mb-8">
            <div className="flex justify-between items-start">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">Services</h1>
                <p className="mt-2 text-gray-600">
                  Monitor which services are writing to which database tables. Services are identified by <code className="bg-gray-100 px-1 rounded">application_name</code> in connection strings.
                </p>
              </div>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => {
                    console.log('[Services] Manual refresh triggered');
                    loadWriteStats();
                  }}
                  className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loading}
                >
                  {loading ? 'Refreshing...' : 'Refresh'}
                </button>
                <label className="text-sm text-gray-600">
                  Time window:
                  <select
                    value={hours}
                    onChange={(e) => setHours(parseInt(e.target.value, 10))}
                    className="ml-2 px-3 py-1.5 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="1">Last 1 hour</option>
                    <option value="2">Last 2 hours</option>
                    <option value="6">Last 6 hours</option>
                    <option value="12">Last 12 hours</option>
                    <option value="24">Last 24 hours</option>
                    <option value="48">Last 48 hours</option>
                  </select>
                </label>
                <label className="text-sm text-gray-600">
                  Location:
                  <select
                    value={locationFilter}
                    onChange={(e) => setLocationFilter(e.target.value)}
                    className="ml-2 px-3 py-1.5 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="all">All</option>
                    <option value="source">Source</option>
                    <option value="target">Target</option>
                    <option value="aws">AWS RDS</option>
                    <option value="gcp">GCP Cloud SQL</option>
                  </select>
                </label>
              </div>
            </div>
            
            {/* Tabs for AWS/GCP */}
            <div className="mt-4 border-b border-gray-200">
              <nav className="-mb-px flex space-x-8">
                <button
                  onClick={() => setActiveTab('all')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'all'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  All Services ({serviceSummaries.length})
                </button>
                <button
                  onClick={() => setActiveTab('aws')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'aws'
                      ? 'border-orange-500 text-orange-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  AWS RDS ({serviceSummaries.filter(s => s.databaseLocations?.some(loc => loc?.provider === 'aws')).length})
                </button>
                <button
                  onClick={() => setActiveTab('gcp')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'gcp'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  GCP Cloud SQL ({serviceSummaries.filter(s => s.databaseLocations?.some(loc => loc?.provider === 'gcp')).length})
                </button>
              </nav>
            </div>
            <div className="mt-4 flex flex-wrap gap-4 items-center">
              {dataHours && (
                <p className="text-sm text-gray-500">
                  Showing data from the last {dataHours} hour{dataHours !== 1 ? 's' : ''}. CLI tools (psql, pg_dump, etc.) are excluded.
                </p>
              )}
              {(sourceLocation || targetLocation) && (
                <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-md">
                  <span className="text-sm font-medium text-gray-700">Databases:</span>
                  {sourceLocation && (
                    <span className={`px-3 py-1 text-sm rounded font-semibold ${
                      sourceLocation.provider === 'aws' 
                        ? 'bg-orange-100 text-orange-800 border border-orange-300' 
                        : 'bg-gray-100 text-gray-800 border border-gray-300'
                    }`} title={sourceLocation.host}>
                      {sourceLocation.label}
                    </span>
                  )}
                  {targetLocation && (
                    <span className={`px-3 py-1 text-sm rounded font-semibold ${
                      targetLocation.provider === 'gcp' 
                        ? 'bg-blue-100 text-blue-800 border border-blue-300'
                        : 'bg-gray-100 text-gray-800 border border-gray-300'
                    }`} title={targetLocation.host}>
                      {targetLocation.label}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {filteredServices.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-12 text-center">
              <p className="text-gray-500">No service write statistics available</p>
              <p className="text-sm text-gray-400 mt-2">
                {activeTab !== 'all' || locationFilter !== 'all' 
                  ? 'No services match the selected filters.'
                  : 'Service tracking queries pg_stat_activity for active connections with application_name set.'}
              </p>
            </div>
          ) : selectedService ? (
            // Service Detail View
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-bold text-gray-900">{selectedService}</h2>
                <button
                  onClick={() => setSelectedService(null)}
                  className="px-4 py-2 bg-gray-600 text-white rounded-md text-sm font-medium hover:bg-gray-700"
                >
                  ← Back to List
                </button>
              </div>
              
              {(() => {
                const summary = filteredServices.find(s => s.serviceName === selectedService);
                if (!summary) return <div>Service not found</div>;
                
                return (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                      <div className="bg-gray-50 p-4 rounded">
                        <div className="text-xs text-gray-500 mb-1">Total Writes</div>
                        <div className="text-2xl font-semibold">{summary.totalWrites.toLocaleString()}</div>
                      </div>
                      <div className="bg-gray-50 p-4 rounded">
                        <div className="text-xs text-gray-500 mb-1">Tables</div>
                        <div className="text-2xl font-semibold">{summary.uniqueTables}</div>
                      </div>
                      <div className="bg-gray-50 p-4 rounded">
                        <div className="text-xs text-gray-500 mb-1">Operations</div>
                        <div className="text-lg font-semibold">{summary.operations.join(', ')}</div>
                      </div>
                      <div className="bg-gray-50 p-4 rounded">
                        <div className="text-xs text-gray-500 mb-1">Last Write</div>
                        <div className="text-sm font-semibold">
                          {summary.lastWriteTime ? new Date(summary.lastWriteTime).toLocaleString() : 'Never'}
                        </div>
                      </div>
                    </div>
                    
                    {summary.databaseLocations && summary.databaseLocations.length > 0 && (
                      <div className="mb-6">
                        <div className="text-sm font-medium text-gray-700 mb-2">Database Locations:</div>
                        <div className="flex gap-2">
                          {/* Show unique providers only (one AWS, one GCP max) */}
                          {Array.from(new Set(summary.databaseLocations.map(loc => loc?.provider).filter(Boolean))).map((provider, idx) => {
                            const loc = summary.databaseLocations.find(l => l?.provider === provider);
                            return (
                              <span
                                key={idx}
                                className={`px-3 py-1 text-sm rounded font-medium ${
                                  provider === 'aws' 
                                    ? 'bg-orange-100 text-orange-800' 
                                    : provider === 'gcp'
                                    ? 'bg-blue-100 text-blue-800'
                                    : 'bg-gray-100 text-gray-800'
                                }`}
                                title={loc?.host}
                              >
                                {loc?.label || 'Unknown'}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    
                    {(summary.usernames.length > 0 || summary.clientAddrs.length > 0) && (
                      <div className="mb-6">
                        {summary.usernames.length > 0 && (
                          <div className="mb-2">
                            <span className="text-sm font-medium text-gray-700">Usernames: </span>
                            <span className="text-sm text-gray-600 font-mono">{summary.usernames.join(', ')}</span>
                          </div>
                        )}
                        {summary.clientAddrs.length > 0 && (
                          <div>
                            <span className="text-sm font-medium text-gray-700">Source IPs: </span>
                            <span className="text-sm text-gray-600 font-mono">{summary.clientAddrs.join(', ')}</span>
                          </div>
                        )}
                      </div>
                    )}
                    
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Table
                            </th>
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Operation
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Writes
                            </th>
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Username
                            </th>
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Source IP
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {summary.stats.map((stat, idx) => (
                            <tr key={idx} className="hover:bg-gray-50">
                              <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-900">
                                <Link
                                  href={`/tables?filter=${stat.table}`}
                                  className="text-blue-600 hover:text-blue-800"
                                >
                                  {stat.table}
                                </Link>
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-center">
                                <span className={`px-2 py-1 text-xs rounded ${
                                  stat.operation === 'INSERT' ? 'bg-green-100 text-green-800' :
                                  stat.operation === 'UPDATE' ? 'bg-blue-100 text-blue-800' :
                                  'bg-red-100 text-red-800'
                                }`}>
                                  {stat.operation}
                                </span>
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                                {stat.count.toLocaleString()}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-center text-sm text-gray-600 font-mono">
                                {stat.username || '—'}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-center text-sm text-gray-600 font-mono">
                                {stat.clientAddr || '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                );
              })()}
            </div>
          ) : (
            // Services List View (Simplified Cards)
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredServices.map((summary) => (
                <div 
                  key={summary.serviceName} 
                  className="bg-white rounded-lg shadow p-6 hover:shadow-lg transition-shadow cursor-pointer"
                  onClick={() => setSelectedService(summary.serviceName)}
                >
                  <div className="flex justify-between items-start mb-4">
                    <h2 className="text-lg font-semibold text-gray-900">
                      {summary.serviceName || 'Unknown Service'}
                    </h2>
                    {summary.databaseLocations && summary.databaseLocations.length > 0 && (
                      <div className="flex gap-1">
                        {/* Show unique providers only (one AWS, one GCP max) */}
                        {Array.from(new Set(summary.databaseLocations.map(loc => loc?.provider).filter(Boolean))).map((provider, idx) => {
                          const loc = summary.databaseLocations.find(l => l?.provider === provider);
                          return (
                            <span
                              key={idx}
                              className={`px-2 py-1 text-xs rounded font-medium ${
                                provider === 'aws' 
                                  ? 'bg-orange-100 text-orange-800' 
                                  : provider === 'gcp'
                                  ? 'bg-blue-100 text-blue-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {provider === 'aws' ? 'AWS' : provider === 'gcp' ? 'GCP' : '?'}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="space-y-2 text-sm text-gray-600">
                    {summary.isPlaceholder ? (
                      <div className="text-gray-500 italic">
                        Connected but no recent writes detected
                      </div>
                    ) : (
                      <>
                        <div>
                          <span className="font-medium">{summary.totalWrites.toLocaleString()}</span> writes
                        </div>
                        <div>
                          <span className="font-medium">{summary.uniqueTables}</span> tables
                        </div>
                        {summary.operations.length > 0 && (
                          <div className="flex gap-1 flex-wrap">
                            {summary.operations.map(op => (
                              <span key={op} className="px-1.5 py-0.5 bg-blue-100 text-blue-800 text-xs rounded">
                                {op}
                              </span>
                            ))}
                          </div>
                        )}
                        {summary.usernames.length > 0 && (
                          <div className="text-xs">
                            <span className="text-gray-500">User:</span>{' '}
                            <span className="font-mono text-gray-700">{summary.usernames[0]}</span>
                            {summary.usernames.length > 1 && (
                              <span className="text-gray-400"> +{summary.usernames.length - 1}</span>
                            )}
                          </div>
                        )}
                        {summary.clientAddrs.length > 0 && (
                          <div className="text-xs">
                            <span className="text-gray-500">IPs:</span>{' '}
                            <span className="font-mono text-gray-700">
                              {summary.clientAddrs.slice(0, 3).join(', ')}
                            </span>
                            {summary.clientAddrs.length > 3 && (
                              <span className="text-gray-400"> +{summary.clientAddrs.length - 3}</span>
                            )}
                          </div>
                        )}
                        {summary.lastWriteTime && (
                          <div className="text-xs text-gray-500">
                            Last: {new Date(summary.lastWriteTime).toLocaleString()}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="mt-4 text-xs text-blue-600 hover:text-blue-800">
                    Click to view details →
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

