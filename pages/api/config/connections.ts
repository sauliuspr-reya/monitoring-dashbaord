import type { NextApiRequest, NextApiResponse } from 'next';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    // Check environment variables first (primary source)
    const sourceUrl = process.env.SOURCE_DATABASE_URL || '';
    const destUrl = process.env.TARGET_DATABASE_URL || '';
    
    // If both env vars are set, use them directly (no need to check K8s secrets)
    if (sourceUrl && destUrl) {
      return res.status(200).json({
        sourceDbConnection: sourceUrl,
        targetDbConnection: destUrl,
      });
    }
    
    // Only try K8s secrets if env vars are missing
    console.log('[config/connections] Environment variables not set, attempting to read from K8s secrets');
    
    const namespace = process.env.KUBERNETES_NAMESPACE || 'reya-mainnet';
    const secretName = process.env.MONITORING_DASHBOARD_SECRET || 'reya-mainnet-monitoring-dashboard-secret';
    const fallbackSecretName = 'postgres-replication-secrets';
    const fallbackNamespace = 'postgres-replication';
    
    try {
      let k8sSourceUrl = '';
      let k8sDestUrl = '';
      
      // Try primary secret first
      try {
        const sourceUrlResult = await execAsync(
          `kubectl get secret -n ${namespace} ${secretName} -o jsonpath='{.data.source-database-url}' 2>/dev/null | base64 -d`
        );
        const destUrlResult = await execAsync(
          `kubectl get secret -n ${namespace} ${secretName} -o jsonpath='{.data.target-database-url}' 2>/dev/null | base64 -d`
        );
        k8sSourceUrl = sourceUrlResult.stdout.trim();
        k8sDestUrl = destUrlResult.stdout.trim();
      } catch (primaryError) {
        // Try fallback secret
        try {
          const sourceUrlResult = await execAsync(
            `kubectl get secret -n ${fallbackNamespace} ${fallbackSecretName} -o jsonpath='{.data.source-database-url}' 2>/dev/null | base64 -d`
          );
          const destUrlResult = await execAsync(
            `kubectl get secret -n ${fallbackNamespace} ${fallbackSecretName} -o jsonpath='{.data.target-database-url}' 2>/dev/null | base64 -d`
          );
          k8sSourceUrl = sourceUrlResult.stdout.trim();
          k8sDestUrl = destUrlResult.stdout.trim();
        } catch (fallbackError) {
          // Both secrets failed, use env vars (even if empty)
          console.log('[config/connections] K8s secrets not available, using environment variables');
        }
      }
      
      // Use K8s secret values if available, otherwise use env vars (which may be empty)
      const finalSourceUrl = k8sSourceUrl || sourceUrl;
      const finalDestUrl = k8sDestUrl || destUrl;
      
      if (k8sSourceUrl && k8sDestUrl) {
        console.log('[config/connections] ✓ Using connection strings from K8s secret');
      }
      
      res.status(200).json({
        sourceDbConnection: finalSourceUrl,
        targetDbConnection: finalDestUrl,
      });
    } catch (kubectlError: any) {
      // If kubectl fails completely, just use env vars
      console.log('[config/connections] K8s secret read failed, using environment variables');
      
      res.status(200).json({
        sourceDbConnection: sourceUrl,
        targetDbConnection: destUrl,
      });
    }
  } catch (error: any) {
    console.error('[config/connections] ❌ ERROR:', error);
    res.status(500).json({ error: error.message || 'Failed to get connections' });
  }
}

