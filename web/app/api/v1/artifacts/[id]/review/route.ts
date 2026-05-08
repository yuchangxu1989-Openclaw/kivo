/**
 * POST /api/v1/artifacts/[id]/review — Review a candidate in an artifact
 * GET /api/v1/artifacts/[id]/review — Get artifact detail
 * FR-L02
 */

import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';

const STORE_KEY = '__kivo_artifact_store__';
type GlobalWithArtifacts = typeof globalThis & { [STORE_KEY]?: Array<Record<string, unknown>> };

function getArtifacts() {
  const scope = globalThis as GlobalWithArtifacts;
  return scope[STORE_KEY] ?? [];
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const artifacts = getArtifacts();
    const artifact = artifacts.find((a: Record<string, unknown>) => a.id === id);
    if (!artifact) return notFound(`Artifact ${id} not found`);
    return NextResponse.json({ data: artifact });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { candidateId, action, editedValue } = body as {
      candidateId: string;
      action: 'approved' | 'rejected' | 'edited';
      editedValue?: string;
    };

    if (!candidateId || !action) {
      return badRequest('candidateId and action are required');
    }

    const artifacts = getArtifacts();
    const artifact = artifacts.find((a: Record<string, unknown>) => a.id === id) as Record<string, unknown> | undefined;
    if (!artifact) return notFound(`Artifact ${id} not found`);

    const decisions = (artifact.candidateDecisions ?? []) as Array<Record<string, unknown>>;
    const existing = decisions.findIndex((d) => d.candidateId === candidateId);
    const record = {
      candidateId,
      action,
      editedValue,
      reviewedAt: new Date().toISOString(),
    };

    if (existing >= 0) {
      decisions[existing] = record;
    } else {
      decisions.push(record);
    }
    artifact.candidateDecisions = decisions;

    // Update review progress
    const reviewCandidateCount =
      ((artifact.entityCandidates as unknown[]) ?? []).length +
      ((artifact.conceptCandidates as unknown[]) ?? []).length +
      ((artifact.conflictCandidates as unknown[]) ?? []).length +
      ((artifact.gapCandidates as unknown[]) ?? []).length +
      ((artifact.extractedClaims as unknown[]) ?? []).length;

    artifact.reviewProgress = { total: reviewCandidateCount, reviewed: decisions.length };
    artifact.updatedAt = new Date().toISOString();

    if (decisions.length >= reviewCandidateCount) {
      artifact.status = 'approved';
    }

    return NextResponse.json({ data: artifact });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
