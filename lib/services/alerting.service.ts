import { getDbPool } from '../db/connection';
import { Alert } from '../types';

export class AlertingService {
  /**
   * Create an alert
   */
  async createAlert(alert: Omit<Alert, 'id' | 'createdAt'>): Promise<Alert> {
    const pool = getDbPool();
    const subscriptionId = alert.subscriptionId || alert.groupId || null;
    
    // Support both subscription_id and group_id columns
    const result = await pool.query(`
      INSERT INTO alerts (
        subscription_id, table_name, alert_type, message, severity
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [
      subscriptionId,
      alert.tableName || null,
      alert.alertType,
      alert.message,
      alert.severity,
    ]).catch(() =>
      pool.query(`
        INSERT INTO alerts (
          group_id, table_name, alert_type, message, severity
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [
        subscriptionId,
        alert.tableName || null,
        alert.alertType,
        alert.message,
        alert.severity,
      ])
    );

    return this.mapRowToAlert(result.rows[0]);
  }

  /**
   * Get unacknowledged alerts
   */
  async getUnacknowledgedAlerts(groupId?: string): Promise<Alert[]> {
    const pool = getDbPool();
    
    // Check which column exists (subscription_id or group_id)
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'alerts' 
        AND column_name IN ('subscription_id', 'group_id')
      LIMIT 1
    `);
    
    const idColumn = columnCheck.rows[0]?.column_name || 'subscription_id';
    
    let query = `
      SELECT * FROM alerts
      WHERE acknowledged = false
    `;
    const params: string[] = [];

    if (groupId) {
      query += ` AND ${idColumn} = $1`;
      params.push(groupId);
    }

    query += ' ORDER BY created_at DESC LIMIT 100';

    const result = await pool.query(query, params);
    return result.rows.map(this.mapRowToAlert);
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(alertId: string, acknowledgedBy: string): Promise<void> {
    const pool = getDbPool();
    await pool.query(`
      UPDATE alerts
      SET acknowledged = true,
          acknowledged_at = NOW(),
          acknowledged_by = $1
      WHERE id = $2
    `, [acknowledgedBy, alertId]);
  }

  /**
   * Check for conditions that should trigger alerts
   */
  async checkAndAlert(
    groupId: string,
    groupName: string,
    status: {
      lagBytes: number;
      lagSeconds: number;
      slotLagBytes: number;
      status: string;
      hasConflict: boolean;
      tableName?: string;
    }
  ): Promise<void> {
    // Alert on high lag
    if (status.lagBytes > 100 * 1024 * 1024) { // 100MB
      await this.createAlert({
        subscriptionId: groupId,
        groupId, // Legacy support
        tableName: status.tableName,
        alertType: 'lag',
        message: `High replication lag detected: ${(status.lagBytes / 1024 / 1024).toFixed(2)}MB for subscription ${groupName}`,
        severity: 'warning',
        acknowledged: false,
      });
    }

    // Alert on very high lag
    if (status.lagBytes > 1024 * 1024 * 1024) { // 1GB
      await this.createAlert({
        subscriptionId: groupId,
        groupId, // Legacy support
        tableName: status.tableName,
        alertType: 'lag',
        message: `Critical replication lag: ${(status.lagBytes / 1024 / 1024 / 1024).toFixed(2)}GB for subscription ${groupName}`,
        severity: 'critical',
        acknowledged: false,
      });
    }

    // Alert on slot lag (WAL accumulation)
    if (status.slotLagBytes > 10 * 1024 * 1024 * 1024) { // 10GB
      await this.createAlert({
        subscriptionId: groupId,
        groupId, // Legacy support
        alertType: 'lag',
        message: `Replication slot lag is high: ${(status.slotLagBytes / 1024 / 1024 / 1024).toFixed(2)}GB. WAL may be accumulating.`,
        severity: 'error',
        acknowledged: false,
      });
    }

    // Alert on replication stopped
    if (status.status === 'stopped' || status.status === 'error') {
      await this.createAlert({
        subscriptionId: groupId,
        groupId, // Legacy support
        tableName: status.tableName,
        alertType: 'connection_failure',
        message: `Replication ${status.status} for subscription ${groupName}${status.tableName ? ` (table: ${status.tableName})` : ''}`,
        severity: 'error',
        acknowledged: false,
      });
    }

    // Alert on conflicts
    if (status.hasConflict) {
      await this.createAlert({
        subscriptionId: groupId,
        groupId, // Legacy support
        tableName: status.tableName,
        alertType: 'conflict',
        message: `Primary key conflict detected in table ${status.tableName} (subscription: ${groupName})`,
        severity: 'error',
        acknowledged: false,
      });
    }
  }

  private mapRowToAlert(row: any): Alert {
    return {
      id: row.id,
      subscriptionId: row.subscription_id || row.group_id,
      groupId: row.subscription_id || row.group_id, // Legacy support
      tableName: row.table_name,
      alertType: row.alert_type,
      message: row.message,
      severity: row.severity,
      acknowledged: row.acknowledged,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
      createdAt: row.created_at,
    };
  }
}

