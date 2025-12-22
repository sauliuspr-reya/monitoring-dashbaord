import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAuth } from 'next-auth/middleware';

// Simple authentication using environment variables
function getAuthConfig() {
  const username = process.env.AUTH_USERNAME || 'admin';
  const password = process.env.AUTH_PASSWORD || 'reyalfg';
  const enabled = process.env.AUTH_ENABLED !== 'false'; // Default to enabled
  
  // Require password if auth is enabled
  if (enabled && !password) {
    console.warn('[middleware] AUTH_ENABLED is true but AUTH_PASSWORD is not set. Authentication may fail.');
  }
  
  return {
    username,
    password: password || '', // Empty string if not set (will fail auth)
    enabled,
  };
}

function isSsoEnabled() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.NEXTAUTH_SECRET
  );
}

const ssoMiddleware = withAuth(
  function middleware() {
    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token }: { token: unknown }) => {
        return !!token;
      },
    },
  }
);

export function middleware(request: NextRequest) {
  // Skip auth for health check endpoints
  if (request.nextUrl.pathname === '/api/healthz' || request.nextUrl.pathname === '/healthz') {
    return NextResponse.next();
  }

  // Use SSO when configured
  if (isSsoEnabled()) {
    return ssoMiddleware(request);
  }

  const auth = getAuthConfig();

  // Skip auth if disabled
  if (!auth.enabled) {
    return NextResponse.next();
  }

  // Check for basic auth header
  const authHeader = request.headers.get('authorization');

  if (authHeader && authHeader.startsWith('Basic ')) {
    const base64Credentials = authHeader.split(' ')[1];
    if (base64Credentials) {
      try {
        const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
        const [username, password] = credentials.split(':');

        if (username === auth.username && password === auth.password) {
          return NextResponse.next();
        }
      } catch (e) {
        // Invalid base64, continue to auth challenge
      }
    }
  }

  // Return 401 with WWW-Authenticate header
  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Replication Monitor"',
    },
  });
}

// Configure which routes to protect
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - api/auth (NextAuth routes)
     * - favicon.ico (favicon file)
     * - healthz (health check endpoint)
     * - public files (public folder)
     */
    '/((?!_next/static|_next/image|api/auth|favicon.ico|healthz|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};

