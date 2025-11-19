/**
 * Next.js Instrumentation Hook
 * Runs once when the server starts
 * Use this to start background workers
 */

export async function register() {
  // Only run in server environment
  if (typeof window !== 'undefined') {
    return;
  }

  // Register ts-node for TypeScript imports (needed for worker files)
  try {
    require('ts-node/register');
  } catch (error) {
    // ts-node might not be available, but that's okay if files are pre-compiled
    console.warn('[instrumentation] ts-node not available, assuming pre-compiled files');
  }

  // Start verification worker (enabled by default, set ENABLE_VERIFICATION_WORKER=false to disable)
  const workerEnabled = process.env.ENABLE_VERIFICATION_WORKER !== 'false';
  
  if (workerEnabled) {
    try {
      const { VerificationWorker } = await import('./lib/worker/verification-worker');
      const worker = new VerificationWorker();
      
      console.log('[instrumentation] Starting verification worker...');
      worker.start().catch((error) => {
        console.error('[instrumentation] Verification worker error:', error);
      });
    } catch (error) {
      console.error('[instrumentation] Failed to start verification worker:', error);
    }
  } else {
    console.log('[instrumentation] Verification worker disabled (ENABLE_VERIFICATION_WORKER=false)');
  }
}

