/**
 * GET /api/v1/graph — Knowledge graph snapshot for visualization
 * Query params: domain, type, since (ISO date)
 *
 * Reads precomputed data from graph_nodes / graph_edges tables (populated by CLI graph-build).
 * No O(N²) computation at request time.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { serverError } from '@/lib/errors';
import { getGraphNodes, getGraphEdges, graphTablesExist } from '@/lib/graph-db';
import type { KnowledgeType } from '@self-evolving-harness/kivo';
import type { ApiResponse } from '@/types';

interface GraphNodeDTO {
  id: string;
  title: string;
  type: string;
  domain?: string;
  tags: string[];
  createdAt: string;
}

interface GraphEdgeDTO {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  strength: number;
  signal: string;
}

interface GraphSnapshotDTO {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  insights?: {
    isolatedNodeIds: string[];
    bridgeNodeIds: string[];
  };
  updatedAt: string;
}

export async function GET(request: NextRequest) {
  try {
    if (!graphTablesExist()) {
      // Graph not yet built — return empty snapshot
      const empty: ApiResponse<GraphSnapshotDTO> = {
        data: { nodes: [], edges: [], insights: { isolatedNodeIds: [], bridgeNodeIds: [] }, updatedAt: new Date().toISOString() },
      };
      return NextResponse.json(empty);
    }

    const { searchParams } = request.nextUrl;
    const domain = searchParams.get('domain') || undefined;
    const type = searchParams.get('type') as KnowledgeType | null;
    const since = searchParams.get('since') || undefined;

    // Read precomputed nodes with SQL-level filtering
    const rawNodes = getGraphNodes({
      domain: domain,
      type: type || undefined,
      since: since,
    });

    const dtoNodes: GraphNodeDTO[] = rawNodes.map((n) => {
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

    // Read edges filtered to visible nodes
    const nodeIds = new Set(dtoNodes.map((n) => n.id));
    const rawEdges = getGraphEdges(nodeIds);

    const dtoEdges: GraphEdgeDTO[] = rawEdges.map((e) => ({
      id: String(e.id),
      sourceId: e.source_id,
      targetId: e.target_id,
      type: e.association_type,
      strength: e.weight,
      signal: e.edge_source,
    }));

    // Compute lightweight insights from precomputed data (O(N+E), not O(N²))
    const degree = new Map<string, number>();
    for (const n of dtoNodes) degree.set(n.id, 0);
    for (const e of dtoEdges) {
      degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
      degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
    }
    const isolatedNodeIds = dtoNodes.filter((n) => (degree.get(n.id) ?? 0) === 0).map((n) => n.id);

    // Bridge detection via Tarjan's algorithm — O(N+E)
    const bridgeNodeIds = findBridgeNodes(dtoNodes, dtoEdges);

    const response: ApiResponse<GraphSnapshotDTO> = {
      data: {
        nodes: dtoNodes,
        edges: dtoEdges,
        insights: { isolatedNodeIds, bridgeNodeIds },
        updatedAt: new Date().toISOString(),
      },
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

/**
 * Tarjan-based bridge node detection — O(N+E).
 * A node is a "bridge node" if removing it increases the number of connected components.
 * We find bridge edges first, then collect their endpoints.
 */
function findBridgeNodes(nodes: GraphNodeDTO[], edges: GraphEdgeDTO[]): string[] {
  if (nodes.length === 0) return [];

  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.sourceId)?.push(e.targetId);
    adj.get(e.targetId)?.push(e.sourceId);
  }

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const bridgeEndpoints = new Set<string>();
  let timer = 0;

  function dfs(u: string, parent: string | null) {
    disc.set(u, timer);
    low.set(u, timer);
    timer++;

    for (const v of adj.get(u) ?? []) {
      if (!disc.has(v)) {
        dfs(v, u);
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
        // If low[v] > disc[u], edge u-v is a bridge
        if (low.get(v)! > disc.get(u)!) {
          bridgeEndpoints.add(u);
          bridgeEndpoints.add(v);
        }
      } else if (v !== parent) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  }

  for (const n of nodes) {
    if (!disc.has(n.id)) {
      dfs(n.id, null);
    }
  }

  return Array.from(bridgeEndpoints);
}
