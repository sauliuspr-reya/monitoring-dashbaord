/**
 * Start verification worker if enabled
 * This can be called from server.js or _app.tsx
 */

let workerStarted = false;

export async function startVerificationWorker() {
  // Only start once
  if (workerStarted) {
    return;
  }

  // Check if worker should be enabled
  if (process.env.ENABLE_VERIFICATION_WORKER !== 'true') {
    console.log('[start-worker] Verification worker disabled (set ENABLE_VERIFICATION_WORKER=true to enable)');
    return;
  }

  try {
    const { VerificationWorker } = await import('./worker/verification-worker');
    const worker = new VerificationWorker();
    
    console.log('[start-worker] Starting verification worker...');
    workerStarted = true;
    
    worker.start().catch((error) => {
      console.error('[start-worker] Verification worker error:', error);
      workerStarted = false;
    });
  } catch (error) {
    console.error('[start-worker] Failed to start verification worker:', error);
  }
}

