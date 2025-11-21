import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState, useEffect } from 'react';

interface VersionInfo {
  version: string;
  commitHash: string;
  commitDate: string;
  branch: string;
  isDirty: boolean;
}

export default function Navbar() {
  const router = useRouter();
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);

  useEffect(() => {
    fetch('/api/version')
      .then(res => res.json())
      .then(data => setVersionInfo(data))
      .catch(err => console.error('Failed to fetch version:', err));
  }, []);

  const navItems = [
    { href: '/tables', label: 'Tables', icon: '📊' },
    { href: '/verification', label: 'Verification', icon: '🔍' },
    { href: '/services', label: 'Services', icon: '⚙️' },
    { type: 'separator' },
    { href: '/backup', label: 'Backup & Restore', icon: '💾' },
    { href: '/publications', label: 'Publications', icon: '📰' },
    { href: '/subscriptions', label: 'Subscriptions', icon: '🔄' },
    { type: 'separator' },
    { href: '/logs', label: 'Logs', icon: '📝' },
  ];

  const isActive = (href: string) => {
    if (href === '/tables') {
      return router.pathname === '/tables' || router.pathname === '/tables/[id]';
    }
    if (href === '/services') {
      return router.pathname.startsWith('/services');
    }
    if (href === '/verification') {
      return router.pathname.startsWith('/verification');
    }
    if (href === '/backup') {
      return router.pathname.startsWith('/backup') || router.pathname.startsWith('/backups');
    }
    if (href === '/publications') {
      return router.pathname.startsWith('/publications');
    }
    if (href === '/subscriptions') {
      return router.pathname.startsWith('/subscriptions') || router.pathname.startsWith('/groups');
    }
    if (href === '/logs') {
      return router.pathname === '/logs';
    }
    return router.pathname === href;
  };

  return (
    <nav className="bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center gap-3">
            <Link href="/tables" className="flex items-center space-x-2">
              <span className="text-xl font-bold text-gray-900">Replication Monitor</span>
            </Link>
            {versionInfo && (
              <div className="group relative">
                <span className="text-xs font-mono px-2 py-1 bg-gray-100 text-gray-600 rounded border border-gray-300 cursor-help">
                  v{versionInfo.version}
                  {versionInfo.commitHash !== 'unknown' && ` • ${versionInfo.commitHash}`}
                  {versionInfo.isDirty && <span className="text-orange-600">*</span>}
                </span>
                <div className="absolute left-0 top-full mt-1 hidden group-hover:block z-50 w-64 p-3 bg-gray-900 text-white text-xs rounded shadow-lg">
                  <div className="space-y-1">
                    <div><strong>Version:</strong> {versionInfo.version}</div>
                    <div><strong>Commit:</strong> {versionInfo.commitHash}</div>
                    <div><strong>Branch:</strong> {versionInfo.branch}</div>
                    {versionInfo.commitDate !== 'unknown' && (
                      <div><strong>Date:</strong> {new Date(versionInfo.commitDate).toLocaleString()}</div>
                    )}
                    {versionInfo.isDirty && (
                      <div className="text-orange-400 mt-2">⚠️ Working directory has uncommitted changes</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1 sm:gap-2">
            {navItems.map((item, index) => {
              if ('type' in item && item.type === 'separator') {
                return (
                  <div key={`separator-${index}`} className="h-6 w-px bg-gray-300 mx-1" />
                );
              }
              if ('href' in item && item.href) {
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                      isActive(item.href)
                        ? 'bg-blue-100 text-blue-700'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`}
                  >
                    <span className="mr-1 sm:mr-2">{item.icon}</span>
                    {item.label}
                  </Link>
                );
              }
              return null;
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}

