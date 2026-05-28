/**
 * POST /api/materials/[id]/subjects — Add a subject association (primary or secondary)
 * GET  /api/materials/[id]/subjects — List subject associations for a material
 *
 * B1+D1: Manages the material_subjects relationship table.
 * Secondary role is used for D1 副领域 (secondary classification).
 */

import { NextRequest, NextResponse } from 'next/server';

import { badRequest, notFound, serverError } from '@/lib/errors';
import { openWebDb } from '@/lib/db';

interface AddSubjectBody {
  subjectId: string;
  role?: 'primary' | 'secondary';
  confidence?: number;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: materialId } = await params;
    const db = openWebDb(true);

    // Verify material exists
    const material = db
      .prepare('SELECT id FROM materials WHERE id = ?')
      .get(materialId) as { id: string } | undefined;

    if (!material) {
      return notFound(`material ${materialId} not found`);
    }

    const subjects = db
      .prepare(`
        SELECT ms.subject_id, ms.role, ms.confidence, ms.created_at,
               sn.name AS subject_name
        FROM material_subjects ms
        LEFT JOIN subject_nodes sn ON sn.id = ms.subject_id
        WHERE ms.material_id = ?
        ORDER BY ms.role ASC, ms.created_at ASC
      `)
      .all(materialId) as Array<{
        subject_id: string;
        role: string;
        confidence: number;
        created_at: string;
        subject_name: string | null;
      }>;

    return NextResponse.json({
      data: subjects.map(s => ({
        subjectId: s.subject_id,
        subjectName: s.subject_name,
        role: s.role,
        confidence: s.confidence,
        createdAt: s.created_at,
      })),
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: materialId } = await params;
    const db = openWebDb(false);

    // Verify material exists
    const material = db
      .prepare('SELECT id FROM materials WHERE id = ?')
      .get(materialId) as { id: string } | undefined;

    if (!material) {
      return notFound(`material ${materialId} not found`);
    }

    let body: AddSubjectBody;
    try {
      body = await request.json();
    } catch {
      return badRequest('request body must be valid JSON');
    }

    if (!body.subjectId) {
      return badRequest('subjectId is required');
    }

    const role = body.role ?? 'secondary';
    if (role !== 'primary' && role !== 'secondary') {
      return badRequest('role must be "primary" or "secondary"');
    }

    // Validate subject exists
    const subject = db
      .prepare('SELECT id, name FROM subject_nodes WHERE id = ? AND merged_into IS NULL')
      .get(body.subjectId) as { id: string; name: string } | undefined;

    if (!subject) {
      return badRequest(`subject ${body.subjectId} not found`);
    }

    // Insert or update the relationship
    db.prepare(`
      INSERT OR REPLACE INTO material_subjects (material_id, subject_id, role, confidence, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(materialId, body.subjectId, role, body.confidence ?? 1.0);

    return NextResponse.json({
      data: {
        materialId,
        subjectId: body.subjectId,
        subjectName: subject.name,
        role,
        confidence: body.confidence ?? 1.0,
      },
    }, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
