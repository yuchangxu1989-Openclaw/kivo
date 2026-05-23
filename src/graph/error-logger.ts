import { randomUUID } from 'node:crypto';
import { ensureOperationalTables, openOperationalDb, type OperationalDbOptions } from '../utils/operational-db.js';

export interface GraphErrorLogInput {
  message: string;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
}

export interface GraphErrorLogRecord {
  id: string;
  message: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export async function logGraphError(
  input: GraphErrorLogInput,
  options: OperationalDbOptions = {},
): Promise<GraphErrorLogRecord> {
  const timestamp = input.timestamp ?? new Date();
  const record: GraphErrorLogRecord = {
    id: randomUUID(),
    message: input.message,
    timestamp,
    metadata: input.metadata,
  };

  const db = openOperationalDb(options);
  try {
    ensureOperationalTables(db);
    db.prepare(`
      INSERT INTO graph_error_logs (id, message, created_at, metadata_json)
      VALUES (?, ?, ?, ?)
    `).run(
      record.id,
      record.message,
      record.timestamp.toISOString(),
      record.metadata ? JSON.stringify(record.metadata) : null,
    );
    return record;
  } finally {
    db.close();
  }
}
