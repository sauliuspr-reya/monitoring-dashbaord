// Type definitions for data integrity verification system

export type VerificationStatus = 'running' | 'completed' | 'stopped' | 'error';

export interface VerificationJob {
  id: number;
  table_name: string;
  status: VerificationStatus;
  batch_size: number;
  cooldown_ms: number;
  primary_key_column: string;
  last_checked_pk_value: string | null;
  total_rows_checked: bigint;
  mismatches_found: number;
  gaps_found: number;
  started_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  error_message: string | null;
}

export interface VerificationMismatch {
  id: number;
  job_id: number;
  table_name: string;
  primary_key_value: string;
  source_row: Record<string, any>;
  target_row: Record<string, any>;
  detected_at: Date;
}

export interface VerificationGap {
  id: number;
  job_id: number;
  table_name: string;
  primary_key_value: string;
  source_row: Record<string, any>;
  detected_at: Date;
}

export interface BatchResult {
  completed: boolean;
  stoppedByUser?: boolean;
  rowsChecked?: number;
  startPkValue?: string;
  lastPkValue?: string;
  mismatchesFound?: number;
  gapsFound?: number;
}

export interface RowWithHash {
  pk: any;
  row_hash: string;
  row_data: Record<string, any>;
}

export interface VerificationConfig {
  tableName: string;
  batchSize: number;
  cooldownMs: number;
  primaryKeyColumn?: string;
}

export interface VerificationProgress {
  job: VerificationJob;
  progressPercentage: number | null;
  estimatedTimeRemaining: string | null;
  rowsPerSecond: number | null;
}
