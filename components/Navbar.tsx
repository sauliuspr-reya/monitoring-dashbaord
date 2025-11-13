import Link from 'next/link';
import { useRouter } from 'next/router';

export default function Navbar() {
  const router = useRouter();

  const navItems = [
    { href: '/tables', label: 'Tables', icon: '📊' },
    { href: '/subscriptions', label: 'Subscriptions', icon: '🔄' },
    { href: '/publications', label: 'Publications', icon: '📰' },
    { href: '/logs', label: 'Logs', icon: '📝' },
    { href: '/services', label: 'Services', icon: '⚙️' },
    { href: '/backup', label: 'Backup & Restore', icon: '💾' },
    { href: '/backups', label: 'Backup Monitor', icon: '📈' },
  ];

  const isActive = (href: string) => {
    if (href === '/tables') {
      return router.pathname === '/tables' || router.pathname === '/tables/[id]';
    }
    if (href === '/subscriptions') {
      return router.pathname.startsWith('/subscriptions') || router.pathname.startsWith('/groups');
    }
    if (href === '/publications') {
      return router.pathname.startsWith('/publications');
    }
    if (href === '/logs') {
      return router.pathname === '/logs';
    }
    if (href === '/services') {
      return router.pathname.startsWith('/services');
    }
    if (href === '/backup') {
      return router.pathname.startsWith('/backup') && !router.pathname.startsWith('/backups');
    }
    if (href === '/backups') {
      return router.pathname.startsWith('/backups');
    }
    return router.pathname === href;
  };

  return (
    <nav className="bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center">
            <Link href="/tables" className="flex items-center space-x-2">
              <span className="text-xl font-bold text-gray-900">Replication Monitor</span>
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-1 sm:gap-2">
            {navItems.map((item) => (
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
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
}

