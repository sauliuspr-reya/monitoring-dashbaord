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

  // Start verification worker if enabled
  if (process.env.ENABLE_VERIFICATION_WORKER === 'true') {
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
    console.log('[instrumentation] Verification worker disabled (set ENABLE_VERIFICATION_WORKER=true to enable)');
  }
}

