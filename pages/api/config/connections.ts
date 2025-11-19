import type { NextApiRequest, NextApiResponse } from 'next';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  console.log('[config/connections] ========== Fetching K8s Secrets ==========');
  
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    // Try to get connection strings from Kubernetes secret
    // First try the actual secret name, then fall back to the old name for compatibility
    const namespace = process.env.KUBERNETES_NAMESPACE || 'reya-mainnet';
    const secretName = process.env.MONITORING_DASHBOARD_SECRET || 'reya-mainnet-monitoring-dashboard-secret';
    const fallbackSecretName = 'postgres-replication-secrets';
    const fallbackNamespace = 'postgres-replication';
    
    console.log(`[config/connections] Attempting to read K8s secret: ${namespace}/${secretName}`);

    try {
      let sourceUrl = '';
      let destUrl = '';
      
      // Try primary secret first
      try {
        const sourceUrlResult = await execAsync(
          `kubectl get secret -n ${namespace} ${secretName} -o jsonpath='{.data.source-database-url}' 2>/dev/null | base64 -d`
        );
        const destUrlResult = await execAsync(
          `kubectl get secret -n ${namespace} ${secretName} -o jsonpath='{.data.target-database-url}' 2>/dev/null | base64 -d`
        );
        sourceUrl = sourceUrlResult.stdout.trim();
        destUrl = destUrlResult.stdout.trim();
      } catch (primaryError) {
        // Try fallback secret
        try {
          const sourceUrlResult = await execAsync(
            `kubectl get secret -n ${fallbackNamespace} ${fallbackSecretName} -o jsonpath='{.data.source-database-url}' 2>/dev/null | base64 -d`
          );
          const destUrlResult = await execAsync(
            `kubectl get secret -n ${fallbackNamespace} ${fallbackSecretName} -o jsonpath='{.data.target-database-url}' 2>/dev/null | base64 -d`
          );
          sourceUrl = sourceUrlResult.stdout.trim();
          destUrl = destUrlResult.stdout.trim();
        } catch (fallbackError) {
          throw primaryError; // Throw original error
        }
      }
      
      if (sourceUrl && destUrl) {
        console.log('[config/connections] ✓ Successfully read K8s secret');
        console.log(`[config/connections]   Source: ${sourceUrl.replace(/:[^:@]+@/, ':***@').substring(0, 50) + '...'}`);
        console.log(`[config/connections]   Target: ${destUrl.replace(/:[^:@]+@/, ':***@').substring(0, 50) + '...'}`);

        res.status(200).json({
          sourceDbConnection: sourceUrl,
          targetDbConnection: destUrl,
        });
        return;
      } else {
        throw new Error('Secret found but connection strings are empty');
      }
    } catch (kubectlError: any) {
      // If kubectl fails, fall back to environment variables
      console.log('[config/connections] ⚠️  kubectl failed or secret not found');
      console.log(`[config/connections]   Error: ${kubectlError.message}`);
      console.log('[config/connections]   Falling back to environment variables');
      
      // Get from environment variables as fallback
      const sourceUrl = process.env.SOURCE_DATABASE_URL || '';
      const destUrl = process.env.TARGET_DATABASE_URL || '';
      
      res.status(200).json({
        sourceDbConnection: sourceUrl,
        targetDbConnection: destUrl,
      });
    }
  } catch (error: any) {
    console.error('[config/connections] ❌ ERROR:', error);
    res.status(500).json({ error: error.message || 'Failed to get connections' });
  }
  
  console.log('[config/connections] ========== Done ==========');
}

