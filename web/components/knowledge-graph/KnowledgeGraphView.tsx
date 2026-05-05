'use client';

import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTheme } from 'next-themes';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceRadial,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { typeLabel } from '@/lib/i18n-labels';

// ─── Types ──────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  title: string;
  type: string;
  domain?: string;
  summary: string;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  strength: number;
  signal: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  insights?: {
    isolatedNodeIds: string[];
    bridgeNodeIds: string[];
  };
  updatedAt: string;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  title: string;
  type: string;
  domain?: string;
  summary: string;
  sourceRef: string;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string;
  edgeType: string;
  strength: number;
}

export interface SelectedNode {
  id: string;
  title: string;
  type: string;
  domain?: string;
  summary: string;
  sourceRef: string;
  connectionCount?: number;
  relations?: { id: string; title: string; type: string; edgeType: string; direction: 'outgoing' | 'incoming' }[];
}

export type GraphLayout = 'force' | 'radial' | 'hierarchy';

interface TooltipState {
  nodeId: string;
  x: number;
  y: number;
  title: string;
  summary: string;
  type: string;
  connectionCount: number;
}

interface KnowledgeGraphViewProps {
  snapshot: GraphSnapshot;
  onNodeClick?: (node: SelectedNode) => void;
  onNodeDoubleClick?: (nodeId: string) => void;
  onCreateLink?: (sourceId: string, targetId: string) => void;
  onDeleteLink?: (edgeId: string) => void;
  className?: string;
  searchHighlightIds?: Set<string>;
  focusNodeId?: string | null;
  depthLimit?: number;
  visibleEdgeTypes?: Set<string>;
  visibleNodeTypes?: Set<string>;
  layout?: GraphLayout;
}

// ─── Color / Style Maps ─────────────────────────────────────────────────────

const NODE_COLORS: Record<string, string> = {
  fact: '#3B82F6',
  decision: '#8B5CF6',
  methodology: '#22C55E',
  experience: '#F97316',
  intent: '#EF4444',
  meta: '#6B7280',
};

const EDGE_STYLES: Record<string, { dash: string; color: string }> = {
  supports: { dash: '', color: '#94A3B8' },
  depends_on: { dash: '', color: '#06B6D4' },
  conflicts: { dash: '6,3', color: '#EF4444' },
  supersedes: { dash: '6,3', color: '#F59E0B' },
  co_occurs: { dash: '4,4', color: '#94A3B8' },
  semantic_neighbor: { dash: '2,3', color: '#A855F7' },
};

const MIN_NODE_RADIUS = 10;
const MAX_NODE_RADIUS = 30;
const DIM_OPACITY = 0.15;
const SEARCH_HIGHLIGHT_COLOR = '#FBBF24';

/** Compute hierarchy depth for each node via BFS from root nodes (highest connection count) */
function computeHierarchyDepths(
  nodes: SimNode[],
  links: SimLink[],
): Map<string, number> {
  const depths = new Map<string, number>();
  if (nodes.length === 0) return depths;

  // Build adjacency from links
  const adj = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, new Set());
    inDegree.set(n.id, 0);
  }
  for (const l of links) {
    const sId = typeof l.source === 'string' ? l.source : (l.source as SimNode).id;
    const tId = typeof l.target === 'string' ? l.target : (l.target as SimNode).id;
    adj.get(sId)?.add(tId);
    adj.get(tId)?.add(sId);
    inDegree.set(tId, (inDegree.get(tId) ?? 0) + 1);
  }

  // Roots: nodes with zero in-degree, or if none, the node with most connections
  let roots = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  if (roots.length === 0) {
    const sorted = [...nodes].sort(
      (a, b) => (adj.get(b.id)?.size ?? 0) - (adj.get(a.id)?.size ?? 0),
    );
    roots = [sorted[0].id];
  }

  // BFS
  for (const r of roots) {
    if (depths.has(r)) continue;
    depths.set(r, 0);
    let frontier = [r];
    let d = 0;
    while (frontier.length > 0) {
      d++;
      const next: string[] = [];
      for (const nid of frontier) {
        for (const nb of adj.get(nid) ?? []) {
          if (!depths.has(nb)) {
            depths.set(nb, d);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
  }

  // Assign remaining disconnected nodes depth 0
  for (const n of nodes) {
    if (!depths.has(n.id)) depths.set(n.id, 0);
  }
  return depths;
}

/** BFS to find all nodes within `depth` hops from `startId` */
function getNeighborsAtDepth(
  startId: string,
  adjacency: Map<string, Set<string>>,
  depth: number,
): Set<string> {
  const visited = new Set<string>([startId]);
  let frontier = [startId];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const nid of frontier) {
      const neighbors = adjacency.get(nid);
      if (!neighbors) continue;
      for (const nb of neighbors) {
        if (!visited.has(nb)) {
          visited.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

export function KnowledgeGraphView({
  snapshot,
  onNodeClick,
  onNodeDoubleClick,
  onCreateLink,
  onDeleteLink,
  className,
  searchHighlightIds,
  focusNodeId: externalFocusNodeId,
  depthLimit = 1,
  visibleEdgeTypes,
  visibleNodeTypes,
  layout = 'force',
}: KnowledgeGraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const { resolvedTheme } = useTheme();
  const labelFill = resolvedTheme === 'dark' ? '#e2e8f0' : '#334155';
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [internalFocusedNodeId, setInternalFocusedNodeId] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const simulationRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const dragNodeRef = useRef<string | null>(null);
  const panStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const isPanningRef = useRef(false);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, forceRender] = useState(0);

  // Tooltip state (300ms hover delay)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Drag-to-link state
  const [dragLink, setDragLink] = useState<{ sourceId: string; sourceX: number; sourceY: number; curX: number; curY: number } | null>(null);
  const dragLinkRef = useRef<typeof dragLink>(null);

  // Context menu for edge deletion
  const [contextMenu, setContextMenu] = useState<{ edgeId: string; edgeLabel: string; x: number; y: number } | null>(null);

  // Use external focus if provided, otherwise internal
  const focusedNodeId = externalFocusNodeId ?? internalFocusedNodeId;

  const isolatedSet = useRef(new Set<string>());
  const bridgeSet = useRef(new Set<string>());

  useEffect(() => {
    isolatedSet.current = new Set(snapshot.insights?.isolatedNodeIds ?? []);
    bridgeSet.current = new Set(snapshot.insights?.bridgeNodeIds ?? []);
  }, [snapshot.insights]);

  // Build adjacency for highlight + local graph
  const adjacencyRef = useRef(new Map<string, Set<string>>());
  const edgeIndexRef = useRef(new Map<string, { sourceId: string; targetId: string; edgeType: string }>());

  // Connection count per node for sizing
  const connectionCountRef = useRef(new Map<string, number>());

  useEffect(() => {
    const adj = new Map<string, Set<string>>();
    const edgeIdx = new Map<string, { sourceId: string; targetId: string; edgeType: string }>();
    const connCount = new Map<string, number>();
    for (const n of snapshot.nodes) {
      adj.set(n.id, new Set());
      connCount.set(n.id, 0);
    }
    for (const e of snapshot.edges) {
      adj.get(e.sourceId)?.add(e.targetId);
      adj.get(e.targetId)?.add(e.sourceId);
      edgeIdx.set(e.id, { sourceId: e.sourceId, targetId: e.targetId, edgeType: e.type });
      connCount.set(e.sourceId, (connCount.get(e.sourceId) ?? 0) + 1);
      connCount.set(e.targetId, (connCount.get(e.targetId) ?? 0) + 1);
    }
    adjacencyRef.current = adj;
    edgeIndexRef.current = edgeIdx;
    connectionCountRef.current = connCount;
  }, [snapshot]);

  // Compute max connection count for radius scaling
  const maxConnections = useMemo(() => {
    let max = 1;
    for (const e of snapshot.edges) {
      const sCount = snapshot.edges.filter(
        (ed) => ed.sourceId === e.sourceId || ed.targetId === e.sourceId,
      ).length;
      const tCount = snapshot.edges.filter(
        (ed) => ed.sourceId === e.targetId || ed.targetId === e.targetId,
      ).length;
      if (sCount > max) max = sCount;
      if (tCount > max) max = tCount;
    }
    return max;
  }, [snapshot.edges]);

  function getNodeRadius(nodeId: string): number {
    const count = connectionCountRef.current.get(nodeId) ?? 0;
    if (maxConnections <= 1) return MIN_NODE_RADIUS;
    const t = Math.min(count / maxConnections, 1);
    return MIN_NODE_RADIUS + t * (MAX_NODE_RADIUS - MIN_NODE_RADIUS);
  }

  // Compute visible node set based on focus + depth + type filters
  const visibleNodeSet = useMemo(() => {
    let nodeIds = new Set(snapshot.nodes.map((n) => n.id));

    // Filter by node type
    if (visibleNodeTypes && visibleNodeTypes.size > 0) {
      const typeFiltered = new Set<string>();
      for (const n of snapshot.nodes) {
        if (visibleNodeTypes.has(n.type)) typeFiltered.add(n.id);
      }
      nodeIds = typeFiltered;
    }

    // If focused, restrict to N-hop neighbors
    if (focusedNodeId && adjacencyRef.current.size > 0) {
      const neighbors = getNeighborsAtDepth(focusedNodeId, adjacencyRef.current, depthLimit);
      const intersection = new Set<string>();
      for (const id of nodeIds) {
        if (neighbors.has(id)) intersection.add(id);
      }
      nodeIds = intersection;
    }

    return nodeIds;
  }, [snapshot.nodes, focusedNodeId, depthLimit, visibleNodeTypes]);

  // Compute visible edge set based on edge type filter + visible nodes
  const visibleEdgeSet = useMemo(() => {
    const edgeIds = new Set<string>();
    for (const e of snapshot.edges) {
      if (visibleEdgeTypes && visibleEdgeTypes.size > 0 && !visibleEdgeTypes.has(e.type)) continue;
      if (!visibleNodeSet.has(e.sourceId) || !visibleNodeSet.has(e.targetId)) continue;
      edgeIds.add(e.id);
    }
    return edgeIds;
  }, [snapshot.edges, visibleEdgeTypes, visibleNodeSet]);

  // Build relations for selected node
  const buildRelations = useCallback(
    (nodeId: string) => {
      const relations: SelectedNode['relations'] = [];
      const nodeMap = new Map(snapshot.nodes.map((n) => [n.id, n]));
      for (const e of snapshot.edges) {
        if (e.sourceId === nodeId) {
          const target = nodeMap.get(e.targetId);
          if (target) {
            relations.push({ id: target.id, title: target.title, type: target.type, edgeType: e.type, direction: 'outgoing' });
          }
        } else if (e.targetId === nodeId) {
          const source = nodeMap.get(e.sourceId);
          if (source) {
            relations.push({ id: source.id, title: source.title, type: source.type, edgeType: e.type, direction: 'incoming' });
          }
        }
      }
      return relations;
    },
    [snapshot],
  );

  // d3 simulation — tick updates DOM directly
  useEffect(() => {
    const filteredNodes = snapshot.nodes.filter((n) => visibleNodeSet.has(n.id));
    const simNodes: SimNode[] = filteredNodes.map((n) => ({
      id: n.id,
      title: n.title,
      type: n.type,
      domain: n.domain,
      summary: n.summary,
      sourceRef: n.sourceRef,
    }));
    const nodeMap = new Map(simNodes.map((n) => [n.id, n]));
    const filteredEdges = snapshot.edges.filter((e) => visibleEdgeSet.has(e.id));
    const simLinks: SimLink[] = filteredEdges
      .filter((e) => nodeMap.has(e.sourceId) && nodeMap.has(e.targetId))
      .map((e) => ({
        id: e.id,
        source: nodeMap.get(e.sourceId)!,
        target: nodeMap.get(e.targetId)!,
        edgeType: e.type,
        strength: e.strength,
      }));

    nodesRef.current = simNodes;
    linksRef.current = simLinks;
    forceRender((c) => c + 1);

    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(80)
          .strength((l) => l.strength * 0.5),
      );

    if (layout === 'radial') {
      // Radial: nodes orbit around center based on connection count
      const maxConn = Math.max(1, ...simNodes.map((n) => connectionCountRef.current.get(n.id) ?? 0));
      sim
        .force('charge', forceManyBody().strength(-120))
        .force(
          'radial',
          forceRadial<SimNode>(
            (d) => {
              const conn = connectionCountRef.current.get(d.id) ?? 0;
              // More connections → closer to center
              return 50 + (1 - conn / maxConn) * 250;
            },
            0,
            0,
          ).strength(0.8),
        )
        .force('collide', forceCollide<SimNode>((d) => getNodeRadius(d.id) * 1.5));
    } else if (layout === 'hierarchy') {
      // Hierarchy: top-down layered by BFS depth
      const depths = computeHierarchyDepths(simNodes, simLinks);
      const maxDepth = Math.max(1, ...depths.values());
      const layerSpacing = 120;
      sim
        .force('charge', forceManyBody().strength(-80))
        .force(
          'y',
          forceY<SimNode>((d) => {
            const depth = depths.get(d.id) ?? 0;
            return (depth - maxDepth / 2) * layerSpacing;
          }).strength(1),
        )
        .force('x', forceX<SimNode>(0).strength(0.05))
        .force('collide', forceCollide<SimNode>((d) => getNodeRadius(d.id) * 2));
    } else {
      // Force-directed (default)
      sim
        .force('charge', forceManyBody().strength(-200))
        .force('center', forceCenter(0, 0))
        .force('collide', forceCollide<SimNode>((d) => getNodeRadius(d.id) * 2));
    }

    sim.on('tick', () => {
        const g = gRef.current;
        if (!g) return;
        select(g)
          .selectAll<SVGLineElement, SimLink>('line[data-edge-id]')
          .attr('x1', (d) => (d.source as SimNode).x ?? 0)
          .attr('y1', (d) => (d.source as SimNode).y ?? 0)
          .attr('x2', (d) => (d.target as SimNode).x ?? 0)
          .attr('y2', (d) => (d.target as SimNode).y ?? 0);
        select(g)
          .selectAll<SVGGElement, SimNode>('g[data-node-id]')
          .attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

    simulationRef.current = sim;
    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, visibleNodeSet, visibleEdgeSet, layout]);

  // ─── Interaction Handlers ─────────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setTransform((t) => {
      const nk = Math.max(0.1, Math.min(5, t.k * factor));
      return { x: mx - (mx - t.x) * (nk / t.k), y: my - (my - t.y) * (nk / t.k), k: nk };
    });
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const target = (e.target as SVGElement).closest('[data-node-id]');
      if (target) {
        const nodeId = target.getAttribute('data-node-id')!;
        dragNodeRef.current = nodeId;
        const sim = simulationRef.current;
        if (sim) {
          const n = nodesRef.current.find((nd) => nd.id === nodeId);
          if (n) {
            n.fx = n.x;
            n.fy = n.y;
          }
          sim.alphaTarget(0.3).restart();
        }
      } else {
        isPanningRef.current = true;
        panStartRef.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
      }
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [transform],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragNodeRef.current) {
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const x = (e.clientX - rect.left - transform.x) / transform.k;
        const y = (e.clientY - rect.top - transform.y) / transform.k;
        const n = nodesRef.current.find((nd) => nd.id === dragNodeRef.current);
        if (n) {
          n.fx = x;
          n.fy = y;
        }
      } else if (isPanningRef.current && panStartRef.current) {
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        setTransform((t) => ({ ...t, x: panStartRef.current!.tx + dx, y: panStartRef.current!.ty + dy }));
      }
    },
    [transform],
  );

  const handlePointerUp = useCallback(() => {
    if (dragNodeRef.current) {
      const sim = simulationRef.current;
      const n = nodesRef.current.find((nd) => nd.id === dragNodeRef.current);
      if (n) {
        n.fx = null;
        n.fy = null;
      }
      if (sim) sim.alphaTarget(0);
      dragNodeRef.current = null;
    }
    isPanningRef.current = false;
    panStartRef.current = null;
  }, []);

  // Click → focus highlight + build relations
  const handleNodeClick = useCallback(
    (node: SimNode) => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      clickTimerRef.current = setTimeout(() => {
        if (!externalFocusNodeId) {
          setInternalFocusedNodeId((prev) => (prev === node.id ? null : node.id));
        }
        const relations = buildRelations(node.id);
        const connCount = connectionCountRef.current.get(node.id) ?? 0;
        onNodeClick?.({
          id: node.id,
          title: node.title,
          type: node.type,
          domain: node.domain,
          summary: node.summary,
          sourceRef: node.sourceRef,
          connectionCount: connCount,
          relations,
        });
        clickTimerRef.current = null;
      }, 250);
    },
    [onNodeClick, buildRelations, externalFocusNodeId],
  );

  const handleNodeDblClick = useCallback(
    (nodeId: string) => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      onNodeDoubleClick?.(nodeId);
    },
    [onNodeDoubleClick],
  );

  // ─── Drag-to-link handlers ────────────────────────────────────────────────

  const handleLinkDragStart = useCallback(
    (e: React.PointerEvent, nodeId: string) => {
      if (!onCreateLink) return;
      e.stopPropagation();
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (!node) return;
      const sx = (node.x ?? 0) * transform.k + transform.x;
      const sy = (node.y ?? 0) * transform.k + transform.y;
      const state = {
        sourceId: nodeId,
        sourceX: sx,
        sourceY: sy,
        curX: e.clientX - rect.left,
        curY: e.clientY - rect.top,
      };
      setDragLink(state);
      dragLinkRef.current = state;
    },
    [onCreateLink, transform],
  );

  const handleLinkDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragLinkRef.current) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const updated = {
        ...dragLinkRef.current,
        curX: e.clientX - rect.left,
        curY: e.clientY - rect.top,
      };
      setDragLink(updated);
      dragLinkRef.current = updated;
    },
    [],
  );

  const handleLinkDragEnd = useCallback(
    (e: React.PointerEvent) => {
      if (!dragLinkRef.current || !onCreateLink) {
        setDragLink(null);
        dragLinkRef.current = null;
        return;
      }
      // Find target node under pointer
      const svg = svgRef.current;
      if (!svg) { setDragLink(null); dragLinkRef.current = null; return; }
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left - transform.x) / transform.k;
      const py = (e.clientY - rect.top - transform.y) / transform.k;
      let targetNode: SimNode | null = null;
      for (const n of nodesRef.current) {
        const dx = (n.x ?? 0) - px;
        const dy = (n.y ?? 0) - py;
        const r = getNodeRadius(n.id);
        if (dx * dx + dy * dy <= r * r * 4 && n.id !== dragLinkRef.current.sourceId) {
          targetNode = n;
          break;
        }
      }
      if (targetNode) {
        onCreateLink(dragLinkRef.current.sourceId, targetNode.id);
      }
      setDragLink(null);
      dragLinkRef.current = null;
    },
    [onCreateLink, transform],
  );

  const focusNeighbors = focusedNodeId ? adjacencyRef.current.get(focusedNodeId) : null;

  function isNodeHighlighted(nodeId: string): boolean {
    if (!focusedNodeId) return true;
    return nodeId === focusedNodeId || (focusNeighbors?.has(nodeId) ?? false);
  }

  function isEdgeHighlighted(edgeId: string): boolean {
    if (!focusedNodeId) return true;
    const e = edgeIndexRef.current.get(edgeId);
    if (!e) return false;
    return e.sourceId === focusedNodeId || e.targetId === focusedNodeId;
  }

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      <svg
        ref={svgRef}
        className="w-full h-full"
        onWheel={handleWheel}
        onPointerDown={(e) => {
          if (dragLinkRef.current) return;
          handlePointerDown(e);
        }}
        onPointerMove={(e) => {
          if (dragLinkRef.current) {
            handleLinkDragMove(e);
          } else {
            handlePointerMove(e);
          }
        }}
        onPointerUp={(e) => {
          if (dragLinkRef.current) {
            handleLinkDragEnd(e);
          } else {
            handlePointerUp();
          }
        }}
        style={{ touchAction: 'none' }}
      >
        <defs>
          <filter id="bridge-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="search-glow">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g ref={gRef} transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {linksRef.current.map((link) => {
            const style = EDGE_STYLES[link.edgeType] ?? EDGE_STYLES.supports;
            const highlighted = isEdgeHighlighted(link.id);
            return (
              <line
                key={link.id}
                data-edge-id={link.id}
                stroke={style.color}
                strokeWidth={highlighted ? 1.5 : 1}
                strokeDasharray={style.dash}
                opacity={highlighted ? 0.8 : DIM_OPACITY}
              />
            );
          })}
          {nodesRef.current.map((node) => {
            const color = NODE_COLORS[node.type] ?? '#6B7280';
            const highlighted = isNodeHighlighted(node.id);
            const isHovered = hoveredNode === node.id;
            const isIsolated = isolatedSet.current.has(node.id);
            const isBridge = bridgeSet.current.has(node.id);
            const isSearchHighlighted = searchHighlightIds?.has(node.id) ?? false;
            const nodeOpacity = highlighted ? 1 : DIM_OPACITY;
            const radius = getNodeRadius(node.id);
            const displayRadius = isHovered ? radius + 2 : radius;

            return (
              <g
                key={node.id}
                data-node-id={node.id}
                transform="translate(0,0)"
                style={{ cursor: onCreateLink ? 'crosshair' : 'pointer' }}
                onPointerEnter={(e) => {
                  setHoveredNode(node.id);
                  if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
                  tooltipTimerRef.current = setTimeout(() => {
                    const rect = containerRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    setTooltip({
                      nodeId: node.id,
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top,
                      title: node.title,
                      summary: node.summary,
                      type: node.type,
                      connectionCount: connectionCountRef.current.get(node.id) ?? 0,
                    });
                  }, 300);
                }}
                onPointerLeave={() => {
                  setHoveredNode(null);
                  if (tooltipTimerRef.current) { clearTimeout(tooltipTimerRef.current); tooltipTimerRef.current = null; }
                  setTooltip(null);
                }}
                onClick={() => handleNodeClick(node)}
                onDoubleClick={() => handleNodeDblClick(node.id)}
                onPointerDown={(e) => {
                  if (e.shiftKey && onCreateLink) {
                    handleLinkDragStart(e, node.id);
                  }
                }}
              >
                {/* Search highlight ring */}
                {isSearchHighlighted && (
                  <circle
                    r={radius + 7}
                    fill="none"
                    stroke={SEARCH_HIGHLIGHT_COLOR}
                    strokeWidth={3}
                    opacity={0.9}
                    filter="url(#search-glow)"
                  />
                )}
                {/* Bridge glow */}
                {isBridge && (
                  <circle
                    r={radius + 5}
                    fill="none"
                    stroke="#F59E0B"
                    strokeWidth={2}
                    opacity={nodeOpacity * 0.7}
                    filter="url(#bridge-glow)"
                  />
                )}
                {/* Main node circle */}
                <circle
                  r={displayRadius}
                  fill={color}
                  stroke={isIsolated ? '#EF4444' : isHovered ? '#fff' : 'transparent'}
                  strokeWidth={isIsolated ? 2 : 2}
                  strokeDasharray={isIsolated ? '3,2' : ''}
                  opacity={nodeOpacity}
                />
                {/* Label */}
                {transform.k > 0.6 && (
                  <text
                    dy={-radius - 4}
                    textAnchor="middle"
                    fontSize={11}
                    fill={labelFill}
                    opacity={highlighted ? 1 : DIM_OPACITY}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {node.title.length > 12 ? node.title.slice(0, 12) + '…' : node.title}
                  </text>
                )}
              </g>
            );
          })}
        </g>
        {/* Drag-to-link visual */}
        {dragLink && (
          <line
            x1={dragLink.sourceX}
            y1={dragLink.sourceY}
            x2={dragLink.curX}
            y2={dragLink.curY}
            stroke="#A855F7"
            strokeWidth={2}
            strokeDasharray="6,3"
            opacity={0.8}
            style={{ pointerEvents: 'none' }}
          />
        )}
      </svg>

      {/* Tooltip overlay */}
      {tooltip && (
        <div
          className="absolute z-50 pointer-events-none"
          style={{
            left: tooltip.x + 12,
            top: tooltip.y - 8,
            maxWidth: 280,
          }}
        >
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-lg dark:border-slate-600 dark:bg-slate-800">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: NODE_COLORS[tooltip.type] ?? '#6B7280' }}
              />
              <span className="text-sm font-medium text-slate-900 truncate dark:text-white">
                {tooltip.title}
              </span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed line-clamp-3 dark:text-slate-400">
              {tooltip.summary.length > 100 ? tooltip.summary.slice(0, 100) + '…' : tooltip.summary}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                {typeLabel(tooltip.type)}
              </span>
              <span className="text-[10px] text-slate-400 dark:text-slate-500">
                {tooltip.connectionCount} 个关联
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
