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

  // Skip during build - instrumentation hook runs during build for analysis
  // We only want to actually load the worker at runtime (when server starts)
  // Check multiple indicators that we're in build phase
  const isBuildPhase = 
    process.env.NEXT_PHASE === 'phase-production-build' ||
    (typeof (global as any).__NEXT_DATA__ === 'undefined' && process.env.NODE_ENV === 'production');
  
  if (isBuildPhase) {
    return;
  }

  // Start verification worker (enabled by default, set ENABLE_VERIFICATION_WORKER=false to disable)
  const workerEnabled = process.env.ENABLE_VERIFICATION_WORKER !== 'false';
  
  if (workerEnabled) {
    // Use Function constructor to create a truly dynamic require
    // This prevents webpack from statically analyzing the code
    const loadWorker = new Function(`
      try {
        require('ts-node/register');
      } catch (e) {
        // ts-node might not be available
      }
      const path = require('path');
      const workerPath = path.join(process.cwd(), 'lib', 'worker', 'verification-worker');
      return require(workerPath);
    `);
    
    try {
      const workerModule = loadWorker();
      const VerificationWorker = workerModule.VerificationWorker || workerModule.default?.VerificationWorker || workerModule.default;
      
      if (!VerificationWorker) {
        throw new Error('VerificationWorker not found in module');
      }
      
      const worker = new VerificationWorker();
      
      console.log('[instrumentation] Starting verification worker...');
      worker.start().catch((error: any) => {
        console.error('[instrumentation] Verification worker error:', error);
      });
    } catch (error: any) {
      console.error('[instrumentation] Failed to start verification worker:', error);
    }
  } else {
    console.log('[instrumentation] Verification worker disabled (ENABLE_VERIFICATION_WORKER=false)');
  }
}

