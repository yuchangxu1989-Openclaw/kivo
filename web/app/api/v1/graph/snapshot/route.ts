/**
 * GET /api/v1/graph/snapshot?before=<ISO date>
 * Returns graph data filtered to nodes created before the specified date.
 * FR-FIX-08 AC4: Timeline snapshot endpoint.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, serverError } from '@/lib/errors';
import { getGraphNodes, getGraphEdges, graphTablesExist } from '@/lib/graph-db';
import type { ApiResponse } from '@/types';

interface GraphSnapshotDTO {
  nodes: Array<{
    id: string;
    title: string;
    type: string;
    domain?: string;
    tags: string[];
    createdAt: string;
  }>;
  edges: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    type: string;
    strength: number;
    signal: string;
  }>;
  updatedAt: string;
  meta?: {
    totalNodes: number;
    totalEdges: number;
    displayedNodes: number;
    snapshotDate: string;
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const before = searchParams.get('before');

    if (!before) {
      return badRequest('before parameter is required (ISO date string)');
    }

    // Validate date
    const beforeDate = new Date(before);
    if (isNaN(beforeDate.getTime())) {
      return badRequest('before must be a valid ISO date string');
    }

    if (!graphTablesExist()) {
      const empty: ApiResponse<GraphSnapshotDTO> = {
        data: {
          nodes: [],
          edges: [],
          updatedAt: new Date().toISOString(),
          meta: { totalNodes: 0, totalEdges: 0, displayedNodes: 0, snapshotDate: before },
        },
      };
      return NextResponse.json(empty);
    }

    // Get nodes created before the specified date
    const rawNodes = getGraphNodes({ since: undefined });

    // Filter nodes by created_at <= before
    const filteredNodes = rawNodes.filter((n) => n.created_at <= before);

    const dtoNodes = filteredNodes.map((n) => {
      let tags: string[] = [];
      try { tags = JSON.parse(n.tags_json); } catch { /* empty */ }
      return {
        id: n.entry_id,
        title: n.title,
        type: n.type,
        domain: n.domain ?? undefined,
        tags,
        createdAt: n.created_at,
      };
    });

    // Get edges where both endpoints exist in filtered nodes
    const nodeIds = new Set(dtoNodes.map((n) => n.id));
    const rawEdges = getGraphEdges(nodeIds);

    const dtoEdges = rawEdges.map((e) => ({
      id: String(e.id),
      sourceId: e.source_id,
      targetId: e.target_id,
      type: e.association_type,
      strength: e.weight,
      signal: e.edge_source,
    }));

    const response: ApiResponse<GraphSnapshotDTO> = {
      data: {
        nodes: dtoNodes,
        edges: dtoEdges,
        updatedAt: new Date().toISOString(),
        meta: {
          totalNodes: rawNodes.length,
          totalEdges: dtoEdges.length,
          displayedNodes: dtoNodes.length,
          snapshotDate: before,
        },
      },
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
