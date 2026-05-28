/**
 * /api/v1/goals — CRUD for domain_goals (FR-M01/M02).
 *
 * GET: list all domain goals
 * POST: create a new domain goal
 */

import { NextRequest, NextResponse } from 'next/server';
import { badRequest, serverError } from '@/lib/errors';
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

function safeJsonArray(val: string | null): string[] {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensureTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS domain_goals (
      domain_id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      key_questions TEXT NOT NULL DEFAULT '[]',
      non_goals TEXT NOT NULL DEFAULT '[]',
      research_boundary TEXT NOT NULL DEFAULT '',
      priority_signals TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export async function GET() {
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    ensureTable(db);
    const rows = db.prepare('SELECT * FROM domain_goals ORDER BY created_at ASC').all() as DomainGoalRow[];
    const response: ApiResponse<DomainGoalView[]> = { data: rows.map(rowToView) };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  } finally {
    db?.close();
  }
}

export async function POST(request: NextRequest) {
  let db: Database.Database | null = null;
  try {
    const body = await request.json();
    const domainId = typeof body?.domainId === 'string' ? body.domainId.trim() : '';
    const purpose = typeof body?.purpose === 'string' ? body.purpose.trim() : '';

    if (!domainId || !purpose) {
      return badRequest('domainId and purpose are required');
    }

    const keyQuestions = Array.isArray(body.keyQuestions) ? body.keyQuestions : [];
    const nonGoals = Array.isArray(body.nonGoals) ? body.nonGoals : [];
    const researchBoundary = typeof body.researchBoundary === 'string' ? body.researchBoundary : '';
    const prioritySignals = Array.isArray(body.prioritySignals) ? body.prioritySignals : [];

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    ensureTable(db);

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO domain_goals (domain_id, purpose, key_questions, non_goals, research_boundary, priority_signals, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      domainId, purpose,
      JSON.stringify(keyQuestions), JSON.stringify(nonGoals),
      researchBoundary, JSON.stringify(prioritySignals),
      now, now,
    );

    const inserted = db.prepare('SELECT * FROM domain_goals WHERE domain_id = ?').get(domainId) as DomainGoalRow;
    const response: ApiResponse<DomainGoalView> = { data: rowToView(inserted) };
    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('UNIQUE constraint')) {
      return badRequest('Domain goal already exists for this domainId');
    }
    return serverError(msg);
  } finally {
    db?.close();
  }
}
