/**
 * DELETE /api/v1/seed-data
 * Removes all entries where source_json contains 'seed:demo-data'.
 */

import { NextResponse } from 'next/server';
import { getKivo } from '@/lib/kivo-engine';
import { serverError } from '@/lib/errors';
import { deleteSeedEntries } from '@/lib/paginated-queries';

export async function DELETE() {
  try {
    await getKivo(); // ensure initialized

    const deletedCount = deleteSeedEntries();

    return NextResponse.json({
      data: { deleted: deletedCount },
      meta: { message: `已清空 ${deletedCount} 条通用模板` },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
