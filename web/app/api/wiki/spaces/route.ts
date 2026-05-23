/**
 * GET /api/wiki/spaces — list all wiki spaces
 * POST /api/wiki/spaces — create a new wiki space
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWikiRepository } from '@/lib/wiki-engine';
import { badRequest, serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';

interface WikiSpaceItem {
  id: string;
  title: string;
  description: string;
  summary: string;
  status: string;
  icon?: string;
  entryCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function GET() {
  try {
    const repo = getWikiRepository();
    const spaces = repo.listSpaces();

    const items: WikiSpaceItem[] = spaces.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.content,
      summary: s.summary,
      status: s.status,
      icon: s.metadata.extra?.icon as string | undefined,
      entryCount: repo.getSpaceTree(s.id).children.reduce((count, child) => {
        const visit = (node: typeof child): number => node.type === 'wiki_page' ? 1 : node.children.reduce((sum, nested) => sum + visit(nested), 0);
        return count + visit(child);
      }, 0),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    const response: ApiResponse<WikiSpaceItem[]> = {
      data: items,
      meta: { total: items.length, page: 1, pageSize: items.length },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, description, icon } = body as { title?: string; description?: string; icon?: string };

    if (!title || title.trim().length === 0) {
      return badRequest('title is required');
    }

    const repo = getWikiRepository();
    const duplicate = repo.listSpaces().find((space) => space.title.trim().toLowerCase() === title.trim().toLowerCase());
    if (duplicate) {
      return badRequest('space title must be unique');
    }
    const space = repo.createSpace({
      title: title.trim(),
      description: description?.trim() ?? '',
      summary: description?.trim().slice(0, 100) ?? '',
      metadata: icon ? { extra: { icon } } : undefined,
    });

    return NextResponse.json({ data: { id: space.id, title: space.title } }, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
