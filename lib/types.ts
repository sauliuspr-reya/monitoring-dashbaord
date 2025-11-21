export interface Subscription {
  id: string;
  name: string;
  description?: string;
  sourceDbConnection: string;
  targetDbConnection: string;
  publicationName: string;
  subscriptionName: string;
  slotName: string;
  enabled: boolean;
  dataCopy?: boolean; // Whether copy_data=true was set during subscription creation
  createdAt: Date;
  updatedAt: Date;
}

// Legacy alias for backward compatibility
export type ReplicationGroup = Subscription;

export interface SubscriptionTable {
  id: string;
  subscriptionId: string;
  tableName: string;
  schemaName: string;
  enabled: boolean;
  createdAt: Date;
}

// Legacy alias for backward compatibility
export type ReplicationGroupTable = SubscriptionTable;

export interface ReplicationMetrics {
  id: string;
  subscriptionId: string;
  timestamp: Date;
  lagBytes?: number;
  lagSeconds?: number;
  slotLagBytes?: number;
  workerPid?: number;
  status: 'active' | 'stopped' | 'error';
  lastAppliedLsn?: string;
}

export interface TableReplicationMetrics {
  id: string;
  subscriptionId: string;
  tableName: string;
  timestamp: Date;
  sourceRowCount?: number;
  targetRowCount?: number;
  gapSize?: number;
  lastReplicatedAt?: Date;
  status: 'synced' | 'lagging' | 'error' | 'conflict';
}

export interface ConflictDetection {
  id: string;
  subscriptionId: string;
  groupId?: string; // Legacy support for backward compatibility
  tableName: string;
  errorMessage?: string;
  errorType?: string;
  detectedAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  resolutionNotes?: string;
  severity: 'warning' | 'error' | 'critical';
}

export interface Alert {
  id: string;
  subscriptionId?: string;
  groupId?: string; // Legacy support for backward compatibility
  tableName?: string;
  alertType: 'conflict' | 'lag' | 'gap' | 'connection_failure';
  message: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  acknowledged: boolean;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  createdAt: Date;
}

export interface ReplicationStatus {
  subscriptionId: string;
  subscriptionName: string;
  groupId?: string; // Legacy support for backward compatibility
  groupName?: string; // Legacy support for backward compatibility
  enabled: boolean;
  subscriptionEnabled: boolean;
  workerRunning: boolean;
  workerPid?: number;
  workerState?: string;
  workerSyncState?: string;
  workerReceivedLsn?: string;
  workerLatestEndLsn?: string;
  workerLastMsgSendTime?: Date;
  workerLastMsgReceiptTime?: Date;
  workerWriteLag?: string;
  workerFlushLag?: string;
  workerReplayLag?: string;
  lagBytes: number;
  lagSeconds: number;
  slotLagBytes: number;
  slotName?: string;
  slotActive?: boolean;
  slotInitialLsn?: string;
  slotRestartLsn?: string;
  slotConfirmedFlushLsn?: string;
  slotWalStatus?: string;
  status: 'active' | 'stopped' | 'error';
  lastAppliedAt?: Date;
  lastAppliedLsn?: string;
  replicationState?: string;
  replicationSyncState?: string;
  replicationClientAddr?: string;
  replicationSentLsn?: string;
  replicationWriteLsn?: string;
  replicationFlushLsn?: string;
  replicationReplayLsn?: string;
  tableCount: number;
  tablesWithIssues: number;
  conflicts: number;
  dataCopy?: boolean; // Whether copy_data=true was set during subscription creation
  publicationName?: string;
  subscriptionDbName?: string;
}

// Legacy aliases for backward compatibility
export type GroupId = string;
export type GroupName = string;

export interface TableStatus {
  subscriptionId: string;
  subscriptionName: string;
  tableName: string;
  enabled: boolean;
  sourceRowCount: number;
  targetRowCount: number;
  gapSize: number;
  status: 'synced' | 'lagging' | 'error' | 'conflict';
  lastReplicatedAt?: Date;
  hasConflict: boolean;
}

