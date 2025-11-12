import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GCPLogConflict {
  tableName: string;
  primaryKey: string;
  keyValue: string;
  errorMessage: string;
  timestamp: Date;
  severity: string;
  insertId: string;
}

export class GCPLogsService {
  private projectId: string;
  private instanceId: string;

  constructor(projectId?: string, instanceId?: string) {
    this.projectId = projectId || process.env.GCP_PROJECT_ID || '';
    this.instanceId = instanceId || process.env.GCP_CLOUD_SQL_INSTANCE_ID || '';
  }

  /**
   * Query GCP Cloud SQL logs for primary key conflicts
   * Uses gcloud logging read command
   */
  async queryConflictsFromGCPLogs(
    timeRange: { start: Date; end: Date } = {
      start: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
      end: new Date(),
    }
  ): Promise<GCPLogConflict[]> {
    const conflicts: GCPLogConflict[] = [];

    if (!this.projectId || !this.instanceId) {
      console.warn('GCP project ID or instance ID not configured');
      return conflicts;
    }

    try {
      const startTime = timeRange.start.toISOString();
      const endTime = timeRange.end.toISOString();

      // Query Cloud SQL logs for duplicate key errors
      const filter = `resource.type="cloudsql_database"
        resource.labels.database_id="${this.projectId}:${this.instanceId}"
        severity>=ERROR
        (textPayload=~"duplicate key" OR textPayload=~"violates unique constraint" OR textPayload=~"primary key")
        timestamp>="${startTime}"
        timestamp<="${endTime}"`;

      const command = `gcloud logging read '${filter}' \
        --project=${this.projectId} \
        --format=json \
        --limit=1000 \
        --freshness=1d`;

      const { stdout } = await execAsync(command);
      const logs = JSON.parse(stdout);

      for (const log of logs) {
        const conflict = this.parseLogEntry(log);
        if (conflict) {
          conflicts.push(conflict);
        }
      }
    } catch (error) {
      console.error('Error querying GCP logs:', error);
      // If gcloud is not available, return empty array
      if (error instanceof Error && error.message.includes('gcloud')) {
        console.warn('gcloud CLI not available or not authenticated');
      }
    }

    return conflicts;
  }

  /**
   * Parse a GCP log entry to extract conflict information
   */
  private parseLogEntry(log: any): GCPLogConflict | null {
    const textPayload = log.textPayload || log.jsonPayload?.message || '';
    
    if (!textPayload) {
      return null;
    }

    // Pattern: duplicate key value violates unique constraint "table_pkey"
    const duplicateKeyMatch = textPayload.match(
      /duplicate key value violates unique constraint "([^"]+)"/
    );
    
    if (!duplicateKeyMatch) {
      return null;
    }

    const constraintName = duplicateKeyMatch[1];
    
    // Extract table name from constraint (usually table_pkey or table_column_key)
    const tableMatch = constraintName.match(/^([^_]+)/);
    const tableName = tableMatch ? tableMatch[1] : 'unknown';

    // Try to extract key value from error message
    const keyValueMatch = textPayload.match(/Key \(([^)]+)\)=\(([^)]+)\)/);
    const primaryKey = keyValueMatch ? keyValueMatch[1] : 'unknown';
    const keyValue = keyValueMatch ? keyValueMatch[2] : 'unknown';

    return {
      tableName,
      primaryKey,
      keyValue,
      errorMessage: textPayload.substring(0, 500),
      timestamp: new Date(log.timestamp),
      severity: log.severity || 'ERROR',
      insertId: log.insertId || '',
    };
  }

  /**
   * Query logs for a specific table
   */
  async queryConflictsForTable(
    tableName: string,
    timeRange: { start: Date; end: Date }
  ): Promise<GCPLogConflict[]> {
    const allConflicts = await this.queryConflictsFromGCPLogs(timeRange);
    return allConflicts.filter((c) => c.tableName === tableName);
  }

  /**
   * Get recent conflicts (last hour)
   */
  async getRecentConflicts(): Promise<GCPLogConflict[]> {
    return this.queryConflictsFromGCPLogs({
      start: new Date(Date.now() - 60 * 60 * 1000),
      end: new Date(),
    });
  }
}

