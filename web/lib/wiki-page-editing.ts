import { getWikiRepository } from '@/lib/wiki-engine';
import { openWebDb } from '@/lib/db';
import { ensureMaterialsTable } from '@/lib/wiki-materials-store';
import { enqueuePipelineTaskForMaterial } from '@/lib/queue/pipeline-worker';
import { triggerInProcessDispatch } from '@/lib/queue/in-process-dispatch';

function softDeleteMaterialEntries(db: ReturnType<typeof openWebDb>, materialId: string) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE entries
    SET deleted_at = COALESCE(deleted_at, ?),
        updated_at = ?
    WHERE json_extract(source_json, '$.materialId') = ?
      AND deleted_at IS NULL
  `).run(now, now, materialId);
}

export function triggerWikiMaterialReextract(pageId: string, content: string): {
  materialId: string | null;
  triggered: boolean;
} {
  const repo = getWikiRepository();
  const page = repo.findById(pageId);
  if (!page || page.type !== 'wiki_page') {
    return { materialId: null, triggered: false };
  }

  const rawMaterialId = page.metadata.extra?.materialId;
  const materialId = typeof rawMaterialId === 'string' && rawMaterialId.trim() ? rawMaterialId.trim() : null;
  if (!materialId) {
    return { materialId: null, triggered: false };
  }

  const db = openWebDb(false);
  try {
    ensureMaterialsTable(db);
    const material = db.prepare(`
      SELECT wiki_page_ids_json
      FROM materials
      WHERE id = ?
    `).get(materialId) as { wiki_page_ids_json: string | null } | undefined;

    softDeleteMaterialEntries(db, materialId);

    if (material?.wiki_page_ids_json) {
      try {
        const pageIds = JSON.parse(material.wiki_page_ids_json) as unknown;
        if (Array.isArray(pageIds)) {
          for (const candidateId of pageIds) {
            if (typeof candidateId !== 'string' || candidateId === pageId) continue;
            const candidate = repo.findById(candidateId);
            if (candidate && candidate.type === 'wiki_page') {
              repo.softDeleteNode(candidate.id);
            }
          }
        }
      } catch {
        // Ignore malformed historical payloads and still continue with re-extraction.
      }
    }

    db.prepare(`
      UPDATE materials
      SET content_override = ?,
          pipeline_status = 'pending',
          status = 'processing',
          error_message = NULL,
          wiki_page_count = 0,
          wiki_page_ids_json = '[]',
          total_chunks = NULL,
          processed_chunks = 0,
          extract_count = 0,
          slice_count = 0,
          updated_at = ?
      WHERE id = ?
    `).run(content, new Date().toISOString(), materialId);

    enqueuePipelineTaskForMaterial(db, materialId);
  } finally {
    db.close();
  }

  triggerInProcessDispatch();
  return { materialId, triggered: true };
}
