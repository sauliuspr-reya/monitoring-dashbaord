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
    const namespace = 'postgres-replication';
    const secretName = 'postgres-replication-secrets';
    
    console.log(`[config/connections] Attempting to read K8s secret: ${namespace}/${secretName}`);

    try {
      const sourceUrlResult = await execAsync(
        `kubectl get secret -n ${namespace} ${secretName} -o jsonpath='{.data.source-database-url}' | base64 -d`
      );
      const destUrlResult = await execAsync(
        `kubectl get secret -n ${namespace} ${secretName} -o jsonpath='{.data.destination-database-url}' | base64 -d`
      );

      const sourceUrl = sourceUrlResult.stdout.trim();
      const destUrl = destUrlResult.stdout.trim();
      
      console.log('[config/connections] ✓ Successfully read K8s secret');
      console.log(`[config/connections]   Source: ${sourceUrl ? sourceUrl.replace(/:[^:@]+@/, ':***@').substring(0, 50) + '...' : 'empty'}`);
      console.log(`[config/connections]   Target: ${destUrl ? destUrl.replace(/:[^:@]+@/, ':***@').substring(0, 50) + '...' : 'empty'}`);

      res.status(200).json({
        sourceDbConnection: sourceUrl,
        targetDbConnection: destUrl,
      });
    } catch (kubectlError: any) {
      // If kubectl fails, fall back to environment variables
      console.log('[config/connections] ⚠️  kubectl failed (K8s not available or secret not found)');
      console.log(`[config/connections]   Error: ${kubectlError.message}`);
      console.log('[config/connections]   Falling back to environment variables');
      
      // Get from environment variables as fallback
      const sourceUrl = process.env.SOURCE_DATABASE_URL || '';
      const destUrl = process.env.DESTINATION_DATABASE_URL || process.env.TARGET_DATABASE_URL || '';
      
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

