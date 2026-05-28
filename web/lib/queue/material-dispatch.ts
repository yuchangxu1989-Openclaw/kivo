import { enqueueClassifyTask } from '@/lib/queue/dispatcher';
import { openWebDb } from '@/lib/db';

/**
 * Fire-and-forget bridge from web upload to the FR-A02 dispatcher queue.
 *
 * The upload request only needs to guarantee that a task is enqueued; the
 * dispatcher/cron owns classification and pipeline execution. Any enqueue
 * failure is written back to materials so the UI can show a failed state and
 * let the user retry through the reprocess endpoint.
 */
export function triggerMaterialDispatch(materialId: string): void {
  void enqueueMaterialDispatch(materialId);
}

export async function enqueueMaterialDispatch(materialId: string): Promise<string | null> {
  const db = openWebDb(false);
  try {
    const taskId = enqueueClassifyTask(db, materialId);
    db.prepare(
      `UPDATE materials
          SET pipeline_status = COALESCE(pipeline_status, 'pending'),
              error_message = NULL,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(materialId);
    return taskId;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dispatcher enqueue failed';
    try {
      db.prepare(
        `UPDATE materials
            SET pipeline_status = 'failed',
                status = 'failed',
                error_message = ?,
                updated_at = datetime('now')
          WHERE id = ?`,
      ).run(message.slice(0, 500), materialId);
    } catch {
      // Keep the original enqueue error as the observable failure.
    }
    return null;
  } finally {
    db.close();
  }
}
