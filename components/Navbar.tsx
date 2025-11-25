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

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  group?: string;
}

// Lucide-style SVG icons
const Icons = {
  Table: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  ),
  Search: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  ),
  Settings: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  Pipeline: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  ),
  Database: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  ),
  Refresh: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  ),
  FileText: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  Menu: () => (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
  X: () => (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
};

export default function Navbar() {
  const router = useRouter();
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    fetch('/api/version')
      .then(res => res.json())
      .then(data => setVersionInfo(data))
      .catch(err => console.error('Failed to fetch version:', err));
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [router.pathname]);

  const navItems: NavItem[] = [
    { href: '/tables', label: 'Tables', icon: <Icons.Table />, group: 'Data' },
    { href: '/verification', label: 'Verification', icon: <Icons.Search />, group: 'Data' },
    { href: '/services', label: 'Services', icon: <Icons.Settings />, group: 'Data' },
    { href: '/replication', label: 'Pipeline', icon: <Icons.Pipeline />, group: 'Replication' },
    { href: '/backup', label: 'Backup', icon: <Icons.Database />, group: 'Replication' },
    { href: '/subscriptions', label: 'Subscriptions', icon: <Icons.Refresh />, group: 'Replication' },
    { href: '/logs', label: 'Logs', icon: <Icons.FileText />, group: 'System' },
  ];

  const isActive = (href: string) => {
    if (href === '/tables') return router.pathname === '/tables' || router.pathname === '/tables/[id]';
    if (href === '/services') return router.pathname.startsWith('/services');
    if (href === '/verification') return router.pathname.startsWith('/verification');
    if (href === '/replication') return router.pathname.startsWith('/replication');
    if (href === '/backup') return router.pathname.startsWith('/backup') || router.pathname.startsWith('/backups');
    if (href === '/subscriptions') return router.pathname.startsWith('/subscriptions') || router.pathname.startsWith('/groups');
    if (href === '/logs') return router.pathname === '/logs';
    return router.pathname === href;
  };

  // Group items for mobile menu
  const groupedItems = navItems.reduce((acc, item) => {
    const group = item.group || 'Other';
    if (!acc[group]) acc[group] = [];
    acc[group].push(item);
    return acc;
  }, {} as Record<string, NavItem[]>);

  return (
    <>
      <nav className="bg-gradient-to-r from-slate-900 to-slate-800 sticky top-0 z-40 shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-14">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <Link href="/replication" className="flex items-center gap-2 group">
                <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center shadow-md group-hover:shadow-lg transition-shadow text-white">
                  <Icons.Pipeline />
                </div>
                <span className="text-lg font-semibold text-white hidden sm:block">
                  Replication Monitor
                </span>
              </Link>
              {versionInfo && (
                <div className="hidden md:block group relative">
                  <span className="text-xs font-mono px-2 py-0.5 bg-slate-700/50 text-slate-400 rounded cursor-help">
                    v{versionInfo.version}
                    {versionInfo.isDirty && <span className="text-amber-400 ml-1">•</span>}
                  </span>
                  <div className="absolute left-0 top-full mt-2 hidden group-hover:block z-50 w-64 p-3 bg-slate-900 text-white text-xs rounded-lg shadow-xl border border-slate-700">
                    <div className="space-y-1.5">
                      <div className="flex justify-between"><span className="text-slate-400">Version</span> <span>{versionInfo.version}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Commit</span> <span className="font-mono">{versionInfo.commitHash}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Branch</span> <span>{versionInfo.branch}</span></div>
                      {versionInfo.commitDate !== 'unknown' && (
                        <div className="flex justify-between"><span className="text-slate-400">Date</span> <span>{new Date(versionInfo.commitDate).toLocaleDateString()}</span></div>
                      )}
                      {versionInfo.isDirty && (
                        <div className="text-amber-400 mt-2 pt-2 border-t border-slate-700">⚠️ Uncommitted changes</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Desktop Navigation */}
            <div className="hidden lg:flex items-center gap-1">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
                    isActive(item.href)
                      ? 'bg-white/10 text-white shadow-inner'
                      : 'text-slate-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <span className={isActive(item.href) ? 'text-blue-400' : 'text-slate-400'}>{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </div>

            {/* Mobile menu button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-2 rounded-lg text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? <Icons.X /> : <Icons.Menu />}
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Mobile Menu Drawer */}
      <div
        className={`fixed top-14 right-0 h-[calc(100vh-3.5rem)] w-72 bg-slate-900 z-30 transform transition-transform duration-300 ease-in-out lg:hidden shadow-2xl ${
          mobileMenuOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="p-4 space-y-6 overflow-y-auto h-full">
          {Object.entries(groupedItems).map(([group, items]) => (
            <div key={group}>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 px-3">
                {group}
              </div>
              <div className="space-y-1">
                {items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                      isActive(item.href)
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    <span className={isActive(item.href) ? 'text-blue-200' : 'text-slate-400'}>{item.icon}</span>
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}

          {/* Version info in mobile */}
          {versionInfo && (
            <div className="mt-auto pt-4 border-t border-slate-800">
              <div className="px-3 text-xs text-slate-500 space-y-1">
                <div>Version {versionInfo.version}</div>
                <div className="font-mono">{versionInfo.commitHash}</div>
                {versionInfo.isDirty && (
                  <div className="text-amber-400">⚠️ Uncommitted changes</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

