/**
 * /api/v1/goals/[domainId] — Single domain goal operations (FR-M01/M02).
 *
 * GET: get a single domain goal
 * PUT: update a domain goal
 * DELETE: delete a domain goal
 */

import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

interface DomainGoalRow {
  domain_id: string;
  purpose: string;
  key_questions: string;
  non_goals: string;
  research_boundary: string;
  priority_signals: string;
  created_at: string;
  updated_at: string;
}

interface DomainGoalView {
  domainId: string;
  purpose: string;
  keyQuestions: string[];
  nonGoals: string[];
  researchBoundary: string;
  prioritySignals: string[];
  createdAt: string;
  updatedAt: string;
}

function safeJsonArray(val: string | null): string[] {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToView(row: DomainGoalRow): DomainGoalView {
  return {
    domainId: row.domain_id,
    purpose: row.purpose,
    keyQuestions: safeJsonArray(row.key_questions),
    nonGoals: safeJsonArray(row.non_goals),
    researchBoundary: row.research_boundary,
    prioritySignals: safeJsonArray(row.priority_signals),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type RouteContext = { params: Promise<{ domainId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  let db: Database.Database | null = null;
  try {
    const { domainId } = await context.params;
    db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare('SELECT * FROM domain_goals WHERE domain_id = ?').get(domainId) as DomainGoalRow | undefined;
    if (!row) return notFound('Domain goal not found');
    const response: ApiResponse<DomainGoalView> = { data: rowToView(row) };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  } finally {
    db?.close();
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  let db: Database.Database | null = null;
  try {
    const { domainId } = await context.params;
    const body = await request.json();

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    const existing = db.prepare('SELECT * FROM domain_goals WHERE domain_id = ?').get(domainId) as DomainGoalRow | undefined;
    if (!existing) return notFound('Domain goal not found');

    const now = new Date().toISOString();
    const purpose = typeof body.purpose === 'string' ? body.purpose : existing.purpose;
    const keyQuestions = Array.isArray(body.keyQuestions) ? JSON.stringify(body.keyQuestions) : existing.key_questions;
    const nonGoals = Array.isArray(body.nonGoals) ? JSON.stringify(body.nonGoals) : existing.non_goals;
    const researchBoundary = typeof body.researchBoundary === 'string' ? body.researchBoundary : existing.research_boundary;
    const prioritySignals = Array.isArray(body.prioritySignals) ? JSON.stringify(body.prioritySignals) : existing.priority_signals;

    db.prepare(`
      UPDATE domain_goals SET purpose = ?, key_questions = ?, non_goals = ?, research_boundary = ?, priority_signals = ?, updated_at = ?
      WHERE domain_id = ?
    `).run(purpose, keyQuestions, nonGoals, researchBoundary, prioritySignals, now, domainId);

    const updated = db.prepare('SELECT * FROM domain_goals WHERE domain_id = ?').get(domainId) as DomainGoalRow;
    const response: ApiResponse<DomainGoalView> = { data: rowToView(updated) };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  } finally {
    db?.close();
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  let db: Database.Database | null = null;
  try {
    const { domainId } = await context.params;
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    const existing = db.prepare('SELECT 1 FROM domain_goals WHERE domain_id = ?').get(domainId);
    if (!existing) return notFound('Domain goal not found');

    db.prepare('DELETE FROM domain_goals WHERE domain_id = ?').run(domainId);
    return NextResponse.json({ data: { deleted: true } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  } finally {
    db?.close();
  }
}
