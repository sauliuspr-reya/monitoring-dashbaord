/**
 * Next.js Instrumentation Hook
 * Runs once when the server starts
 * Use this to start background workers
 * 
 * IMPORTANT: This only runs in Node.js runtime, not Edge runtime
 */

export async function register() {
  // Only run in Node.js runtime (not Edge runtime for middleware)
  // Edge runtime doesn't support native Node.js modules like 'pg'
  if (process.env.NEXT_RUNTIME === 'edge') {
    return;
  }

  // Only run in server environment
  if (typeof window !== 'undefined') {
    return;
  }

  // Skip during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return;
  }

  // Start verification worker (always enabled)
  // Use dynamic import to avoid bundling in edge runtime
  try {
    console.log('[instrumentation] Starting verification worker...');
    
    const { VerificationWorker } = await import('./lib/worker/verification-worker');
    const worker = new VerificationWorker();
    
    worker.start().catch((error: any) => {
      console.error('[instrumentation] Verification worker error:', error);
    });
  } catch (error: any) {
    console.error('[instrumentation] Failed to start verification worker:', error);
  }
}

