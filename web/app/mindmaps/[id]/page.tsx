"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Handle,
  Position,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  useNodesInitialized,
  ReactFlowProvider,
} from "reactflow";
import dagre from "@dagrejs/dagre";
import "reactflow/dist/style.css";

import "./nodes.css";
// NOTE: mindmap-editor.css REMOVED on purpose so it cannot hide edges

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

import { searchMindMapNodes } from "../../../lib/api/mindMapNodes";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5261";

const EDGE_STYLE = {
  stroke: "#4b5563",
  strokeWidth: 2.4,
};

const AI_MIN_SCORE = 0.4; // 0–1, higher = fewer AI edges
const AI_MAX_EDGES_PER_NODE = 4; // lower = fewer AI lines per node


// FORCE React Flow to render visible edges regardless of CSS files.
const DEFAULT_EDGE_OPTIONS: Partial<Edge> = {
  type: "smoothstep",
  animated: true,
  style: {
    stroke: "#ef4444", // red
    strokeWidth: 2.5,
  },
};

type MindMapNodeDto = {
  id: string;
  mindMapId: string;
  label?: string;
  text?: string;
  content?: string;
  parentId?: string | null;
  positionX: number;
  positionY: number;
};

type NodeData = {
  label: string;
  highlighted?: boolean;
};


type GraphSnapshot = {
  nodes: Node<NodeData>[];
  edges: Edge[];
};

type RelatedNodeDto = {
  nodeId?: string;
  title?: string;
  excerpt?: string | null;
  similarity?: number;
};

type AiGraphEdgeDto = {
  sourceId?: string;
  targetId?: string;
  score?: number;
};

type AiGraphResponseDto = {
  edges?: AiGraphEdgeDto[];
};

type ChatContextNodeDto = {
  id: string;
  label?: string;
  text?: string | null;
  score?: number;
};

type EvidenceSpanDto = {
  textSpan?: string;
  nodeId?: string;
  chunkId?: string | null;
  score?: number;
};

type SentenceEvidenceDto = {
  sentenceIndex: number;
  sentence: string;
  evidence?: EvidenceSpanDto[];
};

type ChatResponseDto = {
  answer?: string;
  contextNodes?: ChatContextNodeDto[];
  evidenceBySentence?: SentenceEvidenceDto[];
};

type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources?: { id: string; label: string }[];
};


const nodeWidth = 200;
const nodeHeight = 100;

function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: "TB" | "LR" = "TB"
): { nodes: Node[]; edges: Edge[] } {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  const isHorizontal = direction === "LR";
  dagreGraph.setGraph({
    rankdir: "TB",
    nodesep: 80,
    ranksep: 120,
  });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const dagreNode = dagreGraph.node(node.id);

    return {
      ...node,
      position: {
        x: dagreNode.x - nodeWidth / 2,
        y: dagreNode.y - nodeHeight / 2,
      },
      sourcePosition: isHorizontal ? "right" : "bottom",
      targetPosition: isHorizontal ? "left" : "top",
    } as Node;
  });

  return { nodes: layoutedNodes, edges };
}

function cloneNodes(nodes: Node<NodeData>[]): Node<NodeData>[] {
  return nodes.map((n) => ({
    ...n,
    position: n.position ? { ...n.position } : n.position,
    data: n.data ? { ...n.data } : n.data,
  }));
}

function cloneEdges(edges: Edge[]): Edge[] {
  return edges.map((e) => ({
    ...e,
    style: e.style ? { ...e.style } : e.style,
  }));
}

// --- Client-side fallback for "Find connections" (works even if backend returns 0) ---
const STOPWORDS = new Set([
  "a","an","the","and","or","but","if","then","else","so","to","of","in","on","for","with","as","at","by","from",
  "is","are","was","were","be","been","being","it","this","that","these","those","i","you","we","they","he","she",
  "them","us","our","your","my","me","his","her","their","not","no","yes","do","does","did","done","can","could",
  "should","would","will","just","than","too","very", "import","imported","imports","file","files","document","branch","branches",
  "mmme","test","unrelated","txt","md","pdf"
]);

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function trigrams(s: string): Set<string> {
  const t = (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  if (t.length < 3) return out;
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
  return out;
}

function diceTrigram(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function textSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const j = jaccard(ta, tb);
  const d = diceTrigram(a, b);
  return 0.65 * j + 0.35 * d;
}

function buildChildrenMapLocal(eds: Edge[]) {
  const m = new Map<string, string[]>();
  for (const e of eds) {
    if (!m.has(e.source)) m.set(e.source, []);
    m.get(e.source)!.push(e.target);
  }
  return m;
}

function getSubtreeIdsLocal(rootId: string, eds: Edge[]): Set<string> {
  const children = buildChildrenMapLocal(eds);
  const out = new Set<string>();
  const q: string[] = [rootId];
  while (q.length) {
    const cur = q.shift()!;
    if (out.has(cur)) continue;
    out.add(cur);
    const kids = children.get(cur) ?? [];
    kids.forEach((k) => q.push(k));
  }
  return out;
}

function isImportedRootNode(n: Node) {
  const label = (n.data as any)?.label;
  return typeof label === "string" && label.startsWith("📄 Imported:");
}

function OvalNode({ data, selected }: NodeProps<NodeData>) {
  const isSelected = !!selected;

  return (
    <div
      className={`oval-node ${data.highlighted ? "ai-highlighted-node" : ""} ${
        isSelected ? "mm-selected-node" : ""
      }`}
      style={{
        transition: "transform 0.25s ease, box-shadow 0.25s ease, border 0.25s ease",
        transform: data.highlighted ? "scale(1.06)" : "scale(1)",

        // ✅ Selection highlight (always visible)
        border: isSelected ? "2px solid #0ea5e9" : undefined,
        boxShadow: isSelected ? "0 0 0 4px rgba(14,165,233,0.18)" : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} className="oval-handle" />
      <Handle type="source" position={Position.Bottom} className="oval-handle" />

      <div className="oval-node-label relative text-sm leading-snug px-2 py-1">
        {typeof data.label === "string" && data.label.startsWith("📄 Imported:") && (
          <span className="absolute -top-3 right-0 text-xs rounded bg-slate-100 border border-slate-200 px-1 py-0.5">
            📄 Imported
          </span>
        )}
        {data.label}
      </div>
    </div>
  );
}

const nodeTypes = {
  ovalNode: OvalNode,
};

function formatSummaryText(raw: string | null): string[] {
  if (!raw) return [];
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const l of lines) {
    const cleaned = l.replace(/^[-•\s]+/, "");
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      unique.push(cleaned);
    }
  }

  return unique;
}

function MindMapEditorInner() {
  const params = useParams();
  const mindMapId = params.id as string;

  const [nodes, setNodes] = useState<Node<NodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  const nodesRef = useRef<Node<NodeData>[]>([]);
  const edgesRef = useRef<Edge[]>([]);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  // Node details panel (show full text for truncated nodes)
  const [isNodeDetailsOpen, setIsNodeDetailsOpen] = useState(false);
  const [nodeDetailsNodeId, setNodeDetailsNodeId] = useState<string | null>(null);
  const [rfInstance, setRfInstance] = useState<any | null>(null);
  const [aiSourceNodes, setAiSourceNodes] = useState<string[]>([]);
  const [activeEdgeId, setActiveEdgeId] = useState<string | null>(null);
  const [aiSources, setAiSources] = useState<
    { id: string; label: string }[]
  >([]);
  const [focusedSourceId, setFocusedSourceId] = useState<string | null>(null);
  const [lockedHighlightNodeIds, setLockedHighlightNodeIds] = useState<string[]>([]);
  const [previewHighlightNodeIds, setPreviewHighlightNodeIds] = useState<string[]>([]);
  const [activeSentenceIndex, setActiveSentenceIndex] = useState<number | null>(null);
  const [nodeDetails, setNodeDetails] = useState<
    Record<string, { label?: string; text?: string | null; content?: string | null }>
  >({});
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importOk, setImportOk] = useState<string | null>(null);
  const [stagingNextY, setStagingNextY] = useState<number>(0);

  const STAGING_LANE_MARGIN_X = 500;   // distance to the right of current map
  const STAGING_LANE_WIDTH = 520;      // visual lane width (world units)
  const STAGING_SLOT_GAP_Y = 180;      // gap between separate imports (roots)
  const STAGING_NODE_GAP_Y = 90;       // vertical spacing inside an import
  const STAGING_NODE_GAP_X = 260;      // horizontal spacing per depth level

  // ✅ Structural edges = true tree edges only (NOT AI, NOT import-connection)
  const isStructuralEdge = useCallback((e: Edge) => {
    const d: any = (e as any).data;
    return d?.kind !== "import-connection" && d?.aiSuggested !== true;
  }, []);

  const getBounds = (nds: Node<NodeData>[]) => {
    if (nds.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    for (const n of nds) {
      minX = Math.min(minX, n.position.x);
      maxX = Math.max(maxX, n.position.x + nodeWidth);
      minY = Math.min(minY, n.position.y);
      maxY = Math.max(maxY, n.position.y + nodeHeight);
    }
    return { minX, maxX, minY, maxY };
  };

  const buildChildrenMap = (eds: Edge[]) => {
    const m = new Map<string, string[]>();
    for (const e of eds) {
      if (!m.has(e.source)) m.set(e.source, []);
      m.get(e.source)!.push(e.target);
    }
    return m;
  };

  const computeSubtreeWithDepth = (rootId: string, eds: Edge[]) => {
    const children = buildChildrenMap(eds);
    const out: Array<{ id: string; depth: number }> = [];
    const q: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
    const seen = new Set<string>();

    while (q.length) {
      const cur = q.shift()!;
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      out.push(cur);

      const kids = children.get(cur.id) ?? [];
      for (const k of kids) q.push({ id: k, depth: cur.depth + 1 });
    }
    return out;
  };

  const moveImportedBranchToStagingLane = async (
    rootNodeId: string,
    rfNodes: Node<NodeData>[],
    rfEdges: Edge[]
  ) => {
    // lane X starts to the right of the current graph
    const bounds = getBounds(rfNodes);
    const laneStartX = bounds.maxX + STAGING_LANE_MARGIN_X;

    // pick a lane Y “slot” so multiple imports stack vertically
    const laneStartY =
      stagingNextY && stagingNextY > 0 ? stagingNextY : bounds.minY;

    const subtree = computeSubtreeWithDepth(rootNodeId, rfEdges);

    // group nodes by depth so we can space them nicely
    const byDepth = new Map<number, string[]>();
    for (const item of subtree) {
      if (!byDepth.has(item.depth)) byDepth.set(item.depth, []);
      byDepth.get(item.depth)!.push(item.id);
    }

    // calculate new positions
    const newPos = new Map<string, { x: number; y: number }>();
    for (const [depth, ids] of byDepth.entries()) {
      ids.forEach((id, idx) => {
        newPos.set(id, {
          x: laneStartX + depth * STAGING_NODE_GAP_X,
          y: laneStartY + idx * STAGING_NODE_GAP_Y,
        });
      });
    }
    
    // ✅ Update next Y slot so future imports stack (prevents "imports far below")
    const maxY =
      Math.max(...Array.from(newPos.values()).map((p) => p.y)) + nodeHeight;

    setStagingNextY(maxY + 180);

    // update UI positions immediately
    setNodes((prev) =>
      prev.map((n) => {
        const p = newPos.get(n.id);
        return p ? { ...n, position: { x: p.x, y: p.y } } : n;
      })
    );

    // persist positions to backend (so refresh keeps lane layout)
    await Promise.all(
      subtree.map(async ({ id }) => {
        const p = newPos.get(id);
        if (!p) return;

        const n = rfNodes.find((x) => x.id === id);
        if (!n) return;

        const parentId = getParentId(id);

        await fetch(`${API_BASE}/api/MindMapNodes/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            mindMapId,
            parentId,
            label: n.data?.label ?? "",
            positionX: p.x,
            positionY: p.y,
          }),
        }).catch(() => {});
      })
    );

    // move the “next slot” down for the next import
    const depths = [...byDepth.keys()];
    const maxCount = depths.length
      ? Math.max(...depths.map((d) => (byDepth.get(d) ?? []).length))
      : 0;

    setStagingNextY(laneStartY + maxCount * STAGING_NODE_GAP_Y + STAGING_SLOT_GAP_Y);
  };

  type ImportedBranch = {
    rootNodeId: string;
    fileName: string;
    createdNodes: number;
    linking?: boolean;
    error?: string | null;
    connectionsAdded?: number;
  };

  const [importedBranches, setImportedBranches] = useState<ImportedBranch[]>([]);

  const [evidencePanel, setEvidencePanel] = useState<{
    open: boolean;
    sentenceIndex: number | null;
    sentence: string | null;
    items: EvidenceSpanDto[];
  }>({
    open: false,
    sentenceIndex: null,
    sentence: null,
    items: [],
  });


  const [history, setHistory] = useState<GraphSnapshot[]>([]);
  const [future, setFuture] = useState<GraphSnapshot[]>([]);

  const canUndo = history.length > 0;
  const canRedo = future.length > 0;

  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    nodeId: string | null;
  }>({
    visible: false,
    x: 0,
    y: 0,
    nodeId: null,
  });

  const hideContextMenu = useCallback(() => {
    setContextMenu((cm) => (cm.visible ? { ...cm, visible: false } : cm));
  }, []);

  const DisabledHint = ({
    disabled,
    tip,
    children,
  }: {
    disabled: boolean;
    tip: string;
    children: React.ReactNode;
  }) => {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span is the trigger so tooltip works even if the inner button is disabled */}
          <span
            className={`inline-flex ${disabled ? "cursor-not-allowed" : ""}`}
            tabIndex={0}
          >
            {children}
          </span>
        </TooltipTrigger>

        {disabled && (
          <TooltipContent
            side="bottom"
            sideOffset={8}
            className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow"
          >
            {tip}
          </TooltipContent>
        )}
      </Tooltip>
    );
  };

  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const [relatedNodes, setRelatedNodes] = useState<RelatedNodeDto[]>([]);
  const [showRelatedPanel, setShowRelatedPanel] = useState(false);
  const [showImportsPanel, setShowImportsPanel] = useState(false);
  const MAX_EXTRA_MAPS = 3; // main + 3 selected = 4 total
  const [selectedMapRootIds, setSelectedMapRootIds] = useState<string[]>([]);

  const [aiEdges, setAiEdges] = useState<Edge[]>([]);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiInfo, setAiInfo] = useState<string | null>(null);

  const [chatQuestion, setChatQuestion] = useState("");
  const [chatAnswer, setChatAnswer] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [evidenceBySentence, setEvidenceBySentence] = useState<SentenceEvidenceDto[]>([]);
  const [expandedEvidence, setExpandedEvidence] = useState<Record<number, boolean>>({});

  const toggleEvidence = (idx: number) => {
    setExpandedEvidence((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(null);

  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [showSummaryPanel, setShowSummaryPanel] = useState(false);
  const [showChatPanel, setShowChatPanel] = useState(false);

  const suppressAutoFitRef = useRef(false);

  // Canvas maps (max 4) + active map for "Add node"
  const [canvasRootIds, setCanvasRootIds] = useState<string[]>([]);
  const [activeCanvasRootId, setActiveCanvasRootId] = useState<string | null>(null);
  const canvasRootIdsRef = useRef<string[]>([]);
  useEffect(() => {
    canvasRootIdsRef.current = canvasRootIds;
  }, [canvasRootIds]);

  // ✅ Pick which open map (root) to use for AI actions (Ask AI / Summarize)
  const pickRootForAi = useCallback(
    (purpose: "summarize" | "ask"): string | null => {
      if (canvasRootIds.length === 0) return null;

      // If only one map, use it
      if (canvasRootIds.length === 1) return canvasRootIds[0];

      // Prefer the currently active canvas root if available
      const preferred =
        activeCanvasRootId && canvasRootIds.includes(activeCanvasRootId)
          ? activeCanvasRootId
          : canvasRootIds[0];

      const options = canvasRootIds.map((id, idx) => {
        const title =
          (nodes.find((n) => n.id === id)?.data as any)?.label ??
          `Map ${id.slice(0, 8)}…`;
        return `${idx + 1}) ${title}`;
      });

      const defaultIndex = Math.max(0, canvasRootIds.indexOf(preferred)) + 1;

      const pick = window.prompt(
        `Multiple maps are open on canvas.\nChoose which map to ${purpose}:\n\n${options.join(
          "\n"
        )}\n\nType 1-${canvasRootIds.length}:`,
        String(defaultIndex)
      );

      // ✅ Robust parsing: accept "2", "2)", "2 - blah", "Map 2", etc.
      const match = (pick ?? "").match(/\d+/);
      const num = match ? parseInt(match[0], 10) : defaultIndex;

      const index = Math.max(0, Math.min(canvasRootIds.length - 1, num - 1));
      return canvasRootIds[index] ?? preferred;
    },
    [canvasRootIds, nodes, activeCanvasRootId]
  );

  const CANVAS_STATE_KEY = useMemo(() => `mindmap:${mindMapId}:canvas`, [mindMapId]);
  const IMPORTS_STATE_KEY = useMemo(() => `mindmap:${mindMapId}:imports`, [mindMapId]);

  const VIEWPORT_STATE_KEY = useMemo(() => `mindmap:${mindMapId}:viewport`, [mindMapId]);
  const IMPORT_CONNECTIONS_KEY = useMemo(() => `mindmap:${mindMapId}:importConnections`, [mindMapId]);

  const importConnectionsStorageKey = useMemo(() => {
    return mindMapId ? `${IMPORT_CONNECTIONS_KEY}:${mindMapId}` : IMPORT_CONNECTIONS_KEY;
  }, [mindMapId]);

  const didRestoreViewportRef = useRef(false);
  const blockAutoFitRef = useRef(false);
  const didInitialCanvasLayoutRef = useRef(false);


  // Restore canvas open maps on first load of this mindMapId
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CANVAS_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.canvasRootIds)) setCanvasRootIds(parsed.canvasRootIds.slice(0, 4));
      if (typeof parsed?.activeCanvasRootId === "string") setActiveCanvasRootId(parsed.activeCanvasRootId);
    } catch {
      // ignore corrupt storage
    }
  }, [CANVAS_STATE_KEY]);

  useEffect(() => {
    setShowImportsPanel(false);
    setShowChatPanel(false);
    setShowSummaryPanel(false);
    setShowRelatedPanel(false);
    setIsNodeDetailsOpen(false);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(IMPORTS_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // basic shape validation
        setImportedBranches(
          parsed
            .filter((x: any) => x && typeof x.rootNodeId === "string")
            .map((x: any) => ({
              rootNodeId: String(x.rootNodeId),
              fileName: String(x.fileName ?? "Imported file"),
              createdNodes: Number(x.createdNodes ?? 0),
            }))
        );
      }
    } catch {
      // ignore corrupt storage
    }
  }, [IMPORTS_STATE_KEY]);

  // Persist whenever open maps / active changes
  useEffect(() => {
    try {
      localStorage.setItem(
        CANVAS_STATE_KEY,
        JSON.stringify({ canvasRootIds, activeCanvasRootId })
      );
    } catch {
      // ignore storage issues
    }
  }, [CANVAS_STATE_KEY, canvasRootIds, activeCanvasRootId]);

  useEffect(() => {
    try {
      localStorage.setItem(IMPORTS_STATE_KEY, JSON.stringify(importedBranches));
    } catch {
      // ignore
    }
  }, [IMPORTS_STATE_KEY, importedBranches]);

  useEffect(() => {
    if (canvasRootIds.length === 0) {
      if (activeCanvasRootId !== null) setActiveCanvasRootId(null);
      return;
    }

    if (!activeCanvasRootId || !canvasRootIds.includes(activeCanvasRootId)) {
      setActiveCanvasRootId(canvasRootIds[0]);
    }
  }, [canvasRootIds, activeCanvasRootId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedNodeIds([]);
        setSelectedEdgeIds([]);
        setNodes((prev) => prev.map((n) => ({ ...n, selected: false })));
        setEdges((prev) => prev.map((e) => ({ ...e, selected: false })));
        setIsNodeDetailsOpen(false);
        setNodeDetailsNodeId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Library roots (unlimited) – this is “all maps we know about”
  const [libraryRootIds, setLibraryRootIds] = useState<string[]>([]);

  // Friendly limit notification (not error-red)
  const [limitNotice, setLimitNotice] = useState<string | null>(null);

  // --- Dynamic slot placement (prevents overlap for large maps) ---
  const SLOT_MARGIN_X = 260;
  const SLOT_MARGIN_Y = 220;


  function getSubtreeBoundsForRoot(rootId: string, nds: Node<NodeData>[], eds: Edge[]) {
    const ids = getSubtreeIdsLocal(rootId, eds);
    const subset = nds.filter((n) => ids.has(n.id));
    if (subset.length === 0) {
      return { width: 0, height: 0 };
   }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of subset) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + nodeWidth);
      maxY = Math.max(maxY, n.position.y + nodeHeight);
    }

    return { width: maxX - minX, height: maxY - minY };
  }

  function computeSlots(
    rootIds: string[],
    nds: Node<NodeData>[],
    eds: Edge[]
  ): Array<{ x: number; y: number }> {
    const count = rootIds.length;
    if (count === 0) return [];

    const bounds = rootIds.map((rid) => getSubtreeBoundsForRoot(rid, nds, eds));
    const gapX = SLOT_MARGIN_X;
    const gapY = SLOT_MARGIN_Y;

    if (count === 1) return [{ x: 0, y: 0 }];

    if (count === 2) {
      const w1 = bounds[0].width, w2 = bounds[1].width;
      const dx = (w1 / 2) + (w2 / 2) + gapX;
      return [
        { x: -dx / 2, y: 0 },
        { x:  dx / 2, y: 0 },
      ];
   }

    if (count === 3) {
      // top row = map1 + map2, bottom = map3 centered
      const w1 = bounds[0].width, w2 = bounds[1].width, w3 = bounds[2].width;
      const h1 = bounds[0].height, h2 = bounds[1].height, h3 = bounds[2].height;

      const topRowW = w1 + w2 + gapX;
      const topRowH = Math.max(h1, h2);

      const yTop = -(topRowH / 2 + gapY / 2);
      const yBottom =  (h3 / 2 + topRowH / 2 + gapY / 2);

      return [
        { x: -(topRowW / 2) + w1 / 2, y: yTop },               // map1 (top-left)
        { x:  (topRowW / 2) - w2 / 2, y: yTop },               // map2 (top-right)
        { x:  0,                        y: yBottom },          // map3 (bottom-center)
      ];
    }

    // count === 4 -> 2x2 packed grid using per-column widths + per-row heights
    const w1 = bounds[0].width, w2 = bounds[1].width, w3 = bounds[2].width, w4 = bounds[3].width;
    const h1 = bounds[0].height, h2 = bounds[1].height, h3 = bounds[2].height, h4 = bounds[3].height;

    const col1W = Math.max(w1, w3);
    const col2W = Math.max(w2, w4);
    const row1H = Math.max(h1, h2);
    const row2H = Math.max(h3, h4);

    const totalW = col1W + col2W + gapX;
    const totalH = row1H + row2H + gapY;

    const xLeft  = -(totalW / 2) + col1W / 2;
    const xRight =  (totalW / 2) - col2W / 2;
    const yTop   = -(totalH / 2) + row1H / 2;
    const yBot   =  (totalH / 2) - row2H / 2;

    return [
      { x: xLeft,  y: yTop }, // map1 TL
      { x: xRight, y: yTop }, // map2 TR
      { x: xLeft,  y: yBot }, // map3 BL
      { x: xRight, y: yBot }, // map4 BR
    ];
  }

  const safeNum = (v: any, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const recordSnapshot = useCallback(() => {
    setHistory((prev) => [
      ...prev,
      {
        nodes: cloneNodes(nodes),
        edges: cloneEdges(edges),
      },
    ]);
    setFuture([]);
  }, [nodes, edges]);

  const getParentId = useCallback(
    (childId: string): string | null => {
      const parentEdge = edges.find((e) => e.target === childId && isStructuralEdge(e));
      return parentEdge?.source ?? null;
    },
    [edges, isStructuralEdge]
  );

  const fetchNodes = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const res = await fetch(`${API_BASE}/api/MindMapNodes/${mindMapId}`);
      if (!res.ok) {
        throw new Error(`Failed to load nodes (${res.status})`);
      }

      const data: MindMapNodeDto[] = await res.json();
      const details: Record<string, { label?: string; text?: string | null; content?: string | null }> = {};
      data.forEach((n) => {
        details[n.id] = {
          label: n.label,
          text: n.text ?? null,
          content: n.content ?? null,
        };
      });
      setNodeDetails(details);

      const rfNodes: Node<NodeData>[] = data.map((n) => ({
        id: n.id,
        type: "ovalNode",
        position: { x: safeNum(n.positionX), y: safeNum(n.positionY) },
        data: {
          label: n.label ?? n.text ?? "",
        },

        // ✅ IMPORTANT: prevents MiniMap SVG NaN radius/coords
        width: nodeWidth,
        height: nodeHeight,
      }));

      const rfEdges: Edge[] = data
        .filter((n) => n.parentId)
        .map((n) => ({
          id: `${n.parentId}-${n.id}`,
          source: n.parentId as string,
          target: n.id,
          type: "smoothstep",
          animated: false,
          style: EDGE_STYLE,
        }));

      setNodes(rfNodes);

      // ✅ Re-hydrate saved import-connection edges so refresh keeps them
      let savedImportEdges: Edge[] = [];
      try {
        const raw = localStorage.getItem(importConnectionsStorageKey);
        const arr = raw ? JSON.parse(raw) : null;

        if (Array.isArray(arr)) {
          const existingNodeIds = new Set(rfNodes.map((n) => n.id));

          savedImportEdges = arr
            .map((c: any) => {
              const source = String(c?.sourceNodeId ?? "");
              const target = String(c?.targetNodeId ?? "");
              const similarity = Number(c?.similarity ?? 0);

              if (!source || !target) return null;
              if (!existingNodeIds.has(source) || !existingNodeIds.has(target)) return null;

              return {
                id: `import-conn-${source}-${target}`,
                source,
                target,
                type: "bezier",
                animated: false,
                style: {
                  stroke: "#22c55e",
                  strokeWidth: 2,
                  strokeDasharray: "6 6",
                  opacity: 0.9,
                },
                label: `${Math.round(similarity * 100)}%`,
                labelStyle: { fill: "#16a34a", fontWeight: 700 },
                labelBgStyle: { fill: "#dcfce7" },
                labelBgPadding: [6, 3],
                labelBgBorderRadius: 4,
                data: { kind: "import-connection", similarity },
              } as Edge;
            })
            .filter(Boolean) as Edge[];
        }
      } catch {
        // ignore
      }

      // Merge tree edges + saved import edges (dedupe by id)
      const merged = [...rfEdges];
      const seen = new Set(merged.map((e) => e.id));
      for (const e of savedImportEdges) {
        if (!seen.has(e.id)) merged.push(e);
      }

      setEdges(merged);
      setHistory([]);

      setHistory([]);
      setFuture([]);
      setAiEdges([]);
      setAiInfo(null);

      // ---- Roots discovery ----
      const incoming = new Set(rfEdges.map((e) => e.target));
      const roots = rfNodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);

      // ✅ Prune imports that no longer exist (e.g., deleted/changed roots)
      setImportedBranches((prev) => prev.filter((b) => roots.includes(b.rootNodeId)));

      // ---- Library = all roots we have ever seen (unlimited) ----
      setLibraryRootIds((prev) => {
        const s = new Set(prev);
        for (const r of roots) s.add(r);
        return Array.from(s);
      });

      // ---- Canvas = restore from localStorage if possible; otherwise keep prev; otherwise open first root ----
      let savedCanvas: string[] = [];
      let savedActive: string | null = null;

      try {
        const raw = localStorage.getItem(`mindmap:${mindMapId}:canvas`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed?.canvasRootIds)) savedCanvas = parsed.canvasRootIds;
          if (typeof parsed?.activeCanvasRootId === "string") savedActive = parsed.activeCanvasRootId;
        }
      } catch {}

      const nextCanvas = (() => {
        const validSaved = savedCanvas.filter((id) => roots.includes(id)).slice(0, 4);
        if (validSaved.length > 0) return validSaved;

        // fallback: keep currently open maps that still exist
        const validPrev = canvasRootIdsRef.current.filter((id) => roots.includes(id)).slice(0, 4);
        if (validPrev.length > 0) return validPrev;

        // fallback: auto-open first root
        return roots.length > 0 ? [roots[0]] : [];
      })();

      setCanvasRootIds(nextCanvas);

      const nextActive =
        (savedActive && nextCanvas.includes(savedActive) && roots.includes(savedActive))
          ? savedActive
          : (nextCanvas[0] ?? null);

      setActiveCanvasRootId(nextActive);

    /*  // ---- Step 5 + initialization for grid layout ----
      // Roots = nodes with no incoming edges (each root == a "map")
      const incoming = new Set(rfEdges.map((e) => e.target));
      const roots = rfNodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);

      // Keep existing order, append newly discovered roots, hard-cap at 4
      setMapRootIds((prev) => {
        const out: string[] = [];

        // keep previous roots that still exist
        for (const id of prev) {
          if (roots.includes(id) && !out.includes(id)) out.push(id);
        }

        // append any new roots
        for (const id of roots) {
          if (!out.includes(id)) out.push(id);
          if (out.length >= 4) break;
        }

        return out.slice(0, 4);
      });*/
      return { rfNodes, rfEdges };

    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to load mind map");
      return null;
    } finally {
      setLoading(false);
    }
  }, [mindMapId, IMPORT_CONNECTIONS_KEY]);

  useEffect(() => {
    if (!mindMapId) return;
    fetchNodes();
  }, [mindMapId, fetchNodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => {
        const next = applyNodeChanges(changes, nds);

        // ✅ Guard against NaN/undefined breaking MiniMap/Background SVG
        return next.map((n) => ({
          ...n,
          position: {
            x: Number.isFinite(n.position?.x) ? n.position.x : 0,
            y: Number.isFinite(n.position?.y) ? n.position.y : 0,
          },
          width: Number.isFinite((n as any).width) ? (n as any).width : nodeWidth,
          height: Number.isFinite((n as any).height) ? (n as any).height : nodeHeight,
        }));
      });
    },
    [setNodes]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [setEdges]
  );

  const onConnect = useCallback(
  async (connection: Connection) => {
    if (!connection.source || !connection.target) return;

    // Update UI immediately
    setEdges((eds) =>
      addEdge(
        {
          ...connection,
          id: `${connection.source}-${connection.target}`,
          style: EDGE_STYLE,
          type: "smoothstep",
          animated: false,
        },
        eds
      )
    );

    // Persist: child.parentId = parent
    const child = nodes.find((n) => n.id === connection.target);
    if (!child) return;

    const updatedDto: Partial<MindMapNodeDto> = {
      id: connection.target,
      mindMapId,
      parentId: connection.source,
      positionX: child.position.x,
      positionY: child.position.y,
      label: child.data?.label ?? "",
    };

    const res = await fetch(`${API_BASE}/api/MindMapNodes/${connection.target}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedDto),
    });

    if (!res.ok) {
      console.error("Failed to persist edge creation", await res.text().catch(() => ""));
    }
  },
  [mindMapId, nodes]
);


  const getNodeLabel = useCallback(
    (id?: string | null) => {
      if (!id) return null;
      const node = nodes.find((n) => n.id === id);
      return node?.data?.label ?? null;
    },
    [nodes]
  );

  const handleFocusNode = useCallback(
    (nodeId: string) => {
      if (!rfInstance) return;
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      rfInstance.setCenter(
        node.position.x + nodeWidth / 2,
        node.position.y + nodeHeight / 2,
        {
          zoom: 1.3,
          duration: 200,
        }
      );
      setSelectedNodeIds([nodeId]);
    },
    [rfInstance, nodes]
  );

  const handleSourceClick = useCallback(
    (nodeId: string) => {
      if (!rfInstance) return;

      // click same source again -> zoom out
      if (focusedSourceId === nodeId) {
        rfInstance.fitView({ padding: 0.2, duration: 400 });
        setFocusedSourceId(null);
        return;
      }

      // click different source -> focus that node
      handleFocusNode(nodeId);
      setFocusedSourceId(nodeId);
    },
    [rfInstance, focusedSourceId, handleFocusNode]
  );

  const getFullNodeText = useCallback((nodeId?: string) => {
    if (!nodeId) return "";
    const d = nodeDetails[nodeId];
    return (d?.content ?? d?.text ?? d?.label ?? "").trim();
  }, [nodeDetails]);



  const onSelectionChange = useCallback(
    ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
      const nodeIds = nodes.map((n) => n.id);
      setSelectedNodeIds(nodeIds);
      setSelectedEdgeIds(edges.map((e) => e.id));

      // ✅ Open/close node details panel (full text)
      if (nodeIds.length === 1) {
        setNodeDetailsNodeId(nodeIds[0]);
        setIsNodeDetailsOpen(true);
      } else {
        setIsNodeDetailsOpen(false);
        setNodeDetailsNodeId(null);
      }

      // ✅ Keep existing related nodes behavior
      if (nodeIds.length === 1) {
        const nodeId = nodeIds[0];
        (async () => {
          try {
            const res = await fetch(
              `${API_BASE}/api/MindMapNodes/${mindMapId}/${nodeId}/related`
            );
            if (!res.ok) {
              setRelatedNodes([]);
              setShowRelatedPanel(false);
              return;
            }
            const related: RelatedNodeDto[] = await res.json();
            setRelatedNodes(related || []);
            setShowRelatedPanel((related ?? []).length > 0);
          } catch (err) {
            console.error("Failed to load related nodes", err);
            setRelatedNodes([]);
            setShowRelatedPanel(false);
          }
        })();
      } else {
        setRelatedNodes([]);
        setShowRelatedPanel(false);
      }
    },
    [mindMapId]
  );

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      setContextMenu({
        visible: true,
        x: event.clientX,
        y: event.clientY,
        nodeId: node.id,
      });
    },
    []
  );

  const handleSearch = useCallback(
    async (event?: React.FormEvent) => {
      if (event) {
        event.preventDefault();
      }

      const query = searchQuery.trim();
      if (!query) return;

      try {
        setSearching(true);
        setError(null);

        const results = (await searchMindMapNodes(
          mindMapId,
          query,
          15
        )) as any[];

        if (results.length > 0 && rfInstance) {
          const first: any = results[0];
          const targetId: string = first.nodeId ?? first.id;

          const targetNode = nodes.find((n) => n.id === targetId);
          if (targetNode) {
            rfInstance.setCenter(
              targetNode.position.x + nodeWidth / 2,
              targetNode.position.y + nodeHeight / 2,
              {
                zoom: 1.2,
                duration: 200,
              }
            );
          }
        }
      } catch (err: any) {
        console.error(err);
        setError(err.message ?? "Search failed");
      } finally {
        setSearching(false);
      }
    },
    [searchQuery, mindMapId, rfInstance, nodes]
  );

    const handleAskChat = useCallback(
    (event?: any) => {
      if (event) {
        event.preventDefault();
      }

      const q = chatQuestion.trim();
      
      const userMsg: ChatMsg = { id: crypto.randomUUID(), role: "user", text: q };
      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMsg = { id: assistantId, role: "assistant", text: "" };

      setChatMessages((prev) => [...prev, userMsg, assistantMsg]);
      setActiveAssistantId(assistantId);
      setChatQuestion(""); // ✅ clears input immediately (ChatGPT-like)

      if (!q) return;

      const rootNodeId = pickRootForAi("ask");
      if (!rootNodeId) return;

      try {
        setChatLoading(true);
        setChatError(null);
        setAiSourceNodes([]); // clear old AI highlights

        const url = `${API_BASE}/api/MindMaps/${mindMapId}/chat/stream?question=${encodeURIComponent(
          q
        )}&topK=5&rootNodeId=${encodeURIComponent(rootNodeId)}`;


        const eventSource = new EventSource(url);

        eventSource.onmessage = (event) => {
          if (event.data === "[DONE]") {
            console.log("[SSE DONE] fetching final JSON...");

            eventSource.close();
            setChatLoading(false);

            // Fetch context nodes once answer is complete
            fetch(`${API_BASE}/api/MindMaps/${mindMapId}/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                question: q,
                topK: 6,
                rootNodeId,
              }),

            })
            .then((res) => res.json())
            .then((data: ChatResponseDto) => {
              console.log("[FINAL JSON]", data);

              // ✅ Use backend answer (fixes typos + structure)
              const sources =
                (data.contextNodes ?? []).map((n) => ({
                  id: n.id,
                  label: (n.label ?? n.text ?? n.id.slice(0, 8) + "…").toString(),
                }));

              setAiSources(sources); // if you still want global state (optional)

              // update the SAME assistant message (fix typos + formatting)
              setChatMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                      ...m,
                      text: data.answer ?? m.text,
                      sources,
                    }
                  : m
              )
            );

              // ✅ Store evidence 
              setEvidenceBySentence(data.evidenceBySentence ?? []);
              console.log("[evidenceBySentence]", data.evidenceBySentence);

              // ✅ Store sources
              const ids = (data.contextNodes ?? []).map((n) => n.id);
              //setAiSourceNodes(ids);

              setChatLoading(false);
            })
            .catch((err) => {
              console.error("Final JSON fetch failed", err);
              setChatLoading(false);
            });

            return;
          }


          // Append chunk safely and immediately
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, text: (m.text ?? "") + event.data } : m
            )
          );

        };


        eventSource.onerror = (err) => {
          console.error("SSE error", err);
          eventSource.close();
          setChatLoading(false);
          setChatError("Streaming failed");
        };
      } catch (err: any) {
        console.error(err);
        setChatLoading(false);
        setChatError(err.message ?? "Streaming failed");
      }
    },
    [chatQuestion, mindMapId, pickRootForAi]
  );

  const handleImportFile = useCallback(
    async (file: File) => {
      if (!mindMapId) return;

      setImporting(true);
      setImportError(null);
      setImportOk(null);

      try {
        const fd = new FormData();
        fd.append("File", file);

        const res = await fetch(`${API_BASE}/api/MindMaps/${mindMapId}/import`, {
          method: "POST",
          body: fd,
        });

        if (!res.ok) {
          const msg = await res.text();
          throw new Error(msg || "Import failed");
        }

        const data = await res.json();

        setImportOk(
          `Imported: ${data.createdNodes ?? "?"} nodes` +
          (data.rootNodeId ? ` (root: ${String(data.rootNodeId).slice(0, 8)}…)` : "")
        );

        // Track imported root so we can “Find connections” later
        if (data.rootNodeId) {
          setImportedBranches((prev) => [
            {
              rootNodeId: data.rootNodeId,
              fileName: file.name,
              createdNodes: data.createdNodes ?? 0,
            },
            ...prev,
          ]);   
        }

        // refresh the graph and immediately reposition ONLY the imported subtree into staging lane
        const graph = await fetchNodes();
        requestAnimationFrame(() => scheduleAutoFit());
        setTimeout(() => scheduleAutoFit(), 150);

        scheduleAutoFit();

        if (data.rootNodeId) {
          setCanvasRootIds((prev) => {
            // already open?
            if (prev.includes(data.rootNodeId)) return prev;

            // if there is a slot, auto-open it
            if (prev.length < 4) {
              setLimitNotice(null);
              setActiveCanvasRootId(data.rootNodeId);
              return [...prev, data.rootNodeId];
            }

            // otherwise, keep it in library only and notify
            setLimitNotice("Canvas limit is 4 maps. Imported file was added to the library. Close or replace a map to open it.");
            return prev;
          });
        }

        // ✅ run again after canvasRootIds potentially changed
        requestAnimationFrame(() => scheduleAutoFit());

      } catch (e: any) {
        setImportError(e?.message ?? "Import failed");
      } finally {
        setImporting(false);
      }
    },
    [mindMapId, fetchNodes]
  );

  const handleFindImportConnections = useCallback(
    async (rootNodeId: string) => {
      if (!mindMapId || !rootNodeId) return;

      setImportedBranches((prev) =>
        prev.map((b) =>
          b.rootNodeId === rootNodeId ? { ...b, linking: true, error: null } : b
        )
      );

      try {
        const res = await fetch(
          `${API_BASE}/api/MindMaps/${mindMapId}/import/${rootNodeId}/connections`,
          { method: "POST" }
        );

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Find connections failed (${res.status})${text ? `: ${text}` : ""}`);
        }

        const data = await res.json();
        const connections = data.connections ?? [];

        // If backend returns 0, fall back to a client-side similarity pass so links still appear.
        let fallbackConnections: Array<{ sourceNodeId: string; targetNodeId: string; similarity: number }> = [];

        if ((connections ?? []).length === 0) {
          const curEdges = edgesRef.current;
          const curNodes = nodesRef.current;

          const subtreeIds = getSubtreeIdsLocal(rootNodeId, curEdges);

          const importedIds = Array.from(subtreeIds);
          const otherIds = curNodes.map((n) => n.id).filter((id) => !subtreeIds.has(id));

          const scored: Array<{ a: string; b: string; s: number }> = [];

          for (const a of importedIds) {
            const aNode = curNodes.find((n) => n.id === a);
            if (aNode && isImportedRootNode(aNode)) continue;

            const aText = getFullNodeText(a) || getNodeLabel(a) || "";
            if (!aText.trim()) continue;

            for (const b of otherIds) {
              const bNode = curNodes.find((n) => n.id === b);
              if (bNode && isImportedRootNode(bNode)) continue;

              const bText = getFullNodeText(b) || getNodeLabel(b) || "";
              if (!bText.trim()) continue;

              const s = textSimilarity(aText, bText);

              // extra guardrails to prevent false positives
              const ta = tokenize(aText);
              const tb = tokenize(bText);

              // require at least 2 shared meaningful tokens
              const setA = new Set(ta);
              let shared = 0;
              for (const t of tb) if (setA.has(t)) shared++;

              const hasEnoughOverlap = shared >= 2;

              // stricter similarity threshold (this is the main fix)
              const passesThreshold = s >= 0.32;

              if (hasEnoughOverlap && passesThreshold) {
                scored.push({ a, b, s });
              }

            }
          }

          scored.sort((x, y) => y.s - x.s);

          const maxEdgesTotal = 18;
          const maxPerImportedNode = 3;
          const perA = new Map<string, number>();

          for (const item of scored) {
            if (fallbackConnections.length >= maxEdgesTotal) break;

            const cur = perA.get(item.a) ?? 0;
            if (cur >= maxPerImportedNode) continue;

            perA.set(item.a, cur + 1);
            fallbackConnections.push({
              sourceNodeId: item.a,
              targetNodeId: item.b,
              similarity: Number(item.s.toFixed(3)),
            });
          }

          if (fallbackConnections.length > 0) {
            setAiInfo(`Find connections: backend returned 0, so showing ${fallbackConnections.length} client-side matches.`);
          } else {
            setAiInfo(
              "No strong cross-map connections found yet. Try importing more related content, or add richer text to nodes (not just short labels)."
            );
          }
        }

        const finalConnections = (connections ?? []).length > 0 ? connections : fallbackConnections;
    
        // ✅ Persist ONLY the latest import-connections for this mindmap (no merging)
        try {
          const normalized = finalConnections.map(
            (c: { sourceNodeId: string; targetNodeId: string; similarity?: number }) => ({
            sourceNodeId: String(c.sourceNodeId),
            targetNodeId: String(c.targetNodeId),
            similarity: Number(c.similarity ?? 0),
          }));

          localStorage.setItem(importConnectionsStorageKey, JSON.stringify(normalized));
        } catch {
          // ignore storage failures
        }

        blockAutoFitRef.current = true;
        // Create edges (skip duplicates)
        // Replace old import-connection edges instead of stacking more
        setEdges((prev) => {
          const kept = prev.filter((e) => e.data?.kind !== "import-connection");
          const existing = new Set(kept.map((e) => e.id));
          const next = [...kept];

          for (const c of finalConnections) {
            const source = String(c.sourceNodeId);
            const target = String(c.targetNodeId);
            const id = `import-conn-${source}-${target}`;

            if (existing.has(id)) continue;
            existing.add(id);

            next.push({
              id,
              source,
              target,
              type: "bezier",
              animated: false,
              style: {
                stroke: "#22c55e",
                strokeWidth: 2,
                strokeDasharray: "6 6",
                opacity: 0.85,
              },
              label: typeof c.similarity === "number" ? c.similarity.toFixed(2) : "",
              labelStyle: { fontSize: 10, fill: "#14532d" },
              labelBgStyle: { fill: "#dcfce7", stroke: "#86efac" },
              labelBgPadding: [3, 4],
              labelBgBorderRadius: 4,
              data: { kind: "import-connection", similarity: c.similarity },
            });
          }

          return next;
        });

        requestAnimationFrame(() => {
          blockAutoFitRef.current = false;
        });

        setImportedBranches((prev) =>
          prev.map((b) =>
            b.rootNodeId === rootNodeId
              ? { ...b, linking: false, connectionsAdded: finalConnections.length }
              : b
          )
        );
      } catch (e: any) {
        setImportedBranches((prev) =>
          prev.map((b) =>
            b.rootNodeId === rootNodeId
              ? { ...b, linking: false, error: e?.message ?? "Find connections failed" }
              : b
          )
        );
      }
    },
        [mindMapId, setEdges, getFullNodeText, getNodeLabel, IMPORT_CONNECTIONS_KEY]
  );

  const saveViewportToStorage = useCallback(
    (vp?: { x: number; y: number; zoom: number }) => {
      const viewport = vp ?? rfInstance?.getViewport?.();
      if (!viewport) return;

      const clean = {
        x: Number.isFinite(viewport.x) ? viewport.x : 0,
        y: Number.isFinite(viewport.y) ? viewport.y : 0,
        zoom: Number.isFinite(viewport.zoom) ? viewport.zoom : 1,
      };

      try {
        localStorage.setItem(VIEWPORT_STATE_KEY, JSON.stringify(clean));
      } catch {}
    },
    [rfInstance, VIEWPORT_STATE_KEY]
  );

  const persistViewportSoon = useCallback(
    (delayMs = 0) => {
      if (!rfInstance) return;
      window.setTimeout(() => {
        try {
          saveViewportToStorage();
        } catch {
          // ignore
        }
      }, delayMs);
    },
    [rfInstance, saveViewportToStorage]
  );

  const handleFocusImport = useCallback(
    (rootNodeId: string) => {
      if (!rfInstance) return;

      const subtreeIds = getSubtreeIdsLocal(rootNodeId, edges.filter(isStructuralEdge));
      const subtreeNodes = nodes.filter((n) => subtreeIds.has(n.id));

      if (subtreeNodes.length === 0) return;

      rfInstance.fitView({
        nodes: subtreeNodes,
        padding: 0.35,
        duration: 450,
        minZoom: 0.8,
        maxZoom: 1.2,
      });
      persistViewportSoon(520);
      setTimeout(() => {
        const z = rfInstance.getZoom();
        if (z < 0.8) {
          const vp = rfInstance.getViewport();
          rfInstance.setViewport({ ...vp, zoom: 0.8 }, { duration: 200 });
          persistViewportSoon(260);
        }
      }, 520);
    },
    [rfInstance, nodes, edges, persistViewportSoon]
  );

  const handleRedockImport = useCallback(
    async (rootNodeId: string) => {
      const graph = await fetchNodes();

      // focus after re-dock
      setTimeout(() => handleFocusImport(rootNodeId), 120);
    },
    [fetchNodes, moveImportedBranchToStagingLane, handleFocusImport]
  );

  // Move a whole map subtree so its bounding box center matches (tx, ty)
  const moveSubtreeTo = useCallback(
    (rootId: string, tx: number, ty: number) => {
      const ids = getSubtreeIdsLocal(rootId, edges.filter(isStructuralEdge));
      const subset = nodes.filter((n) => ids.has(n.id));
      if (subset.length === 0) return;

      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;

      for (const n of subset) {
        const px = safeNum(n.position?.x);
        const py = safeNum(n.position?.y);

        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px + nodeWidth);
        maxY = Math.max(maxY, py + nodeHeight);
      }

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      const dx = tx - cx;
      const dy = ty - cy;

      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

      setNodes((prev) =>
        prev.map((n) =>
          ids.has(n.id)
            ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
            : n
        )
      );
    },
    [nodes, edges, setNodes]
  );

  const nodesInitialized = useNodesInitialized();
  const [layoutTick, setLayoutTick] = useState(0);

  const pendingAutoFitRef = useRef(false);
  const manualLayoutRootsRef = useRef<Set<string>>(new Set());

  const scheduleAutoFit = useCallback(() => {
    if (!rfInstance) return;
    if (blockAutoFitRef.current) return;
    pendingAutoFitRef.current = true;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!pendingAutoFitRef.current) return;
        pendingAutoFitRef.current = false;

        try {
          rfInstance.fitView({
            padding: 0.22, // ✅ a bit more padding (less cramped)
            includeHiddenNodes: false,
            duration: 0,
          });

          // ✅ Clamp zoom so refresh never makes the map look microscopic
          const z = rfInstance.getZoom?.();
          if (typeof z === "number" && z < 0.75) {
            const vp = rfInstance.getViewport?.();
            if (vp) rfInstance.setViewport({ ...vp, zoom: 0.75 }, { duration: 0 });
          }

          // ✅ Also clamp max zoom so auto-fit never zooms in too far
          const z2 = rfInstance.getZoom?.();
          if (typeof z2 === "number" && z2 > 1.05) {
            const vp = rfInstance.getViewport?.();
            if (vp) rfInstance.setViewport({ ...vp, zoom: 1.05 }, { duration: 0 });
          }
          // ✅ Persist final viewport after auto-fit + clamps
          persistViewportSoon(0);
        } catch {
          // ignore
       }
      });
    });
  }, [rfInstance, persistViewportSoon]);
  
  // ✅ Only use structural (tree) edges for layout/subtree calculations.
  // Ignore AI + import-connection edges because they link across maps and break layout.
  const structuralEdges = useMemo(() => {
    return edges.filter((e) => {
      const d: any = (e as any).data;
      const isImportConn = d?.kind === "import-connection";
      const isAi = d?.aiSuggested === true;
      return !isImportConn && !isAi;
    });
  }, [edges]);

  const lastCanvasLayoutKeyRef = useRef<string>("");

  useEffect(() => {
    if (!rfInstance) return;
    if (canvasRootIds.length === 0) return;

    // Only re-run when which maps are open changes OR graph size changes
    const visibleIds = new Set<string>();
    for (const rid of canvasRootIds) {
      for (const id of getSubtreeIdsLocal(rid, structuralEdges)) visibleIds.add(id);
    }

    const structuralEdgeCount = edges.filter((e) => !(e.data as any)?.kind).length; // ignores import-connection edges
    const key = `${canvasRootIds.join("|")}::${structuralEdgeCount}`;

    // 🔒 Snapshot nodes BEFORE any layout shifting (prevents drift)
    const layoutBaseNodes = nodes.map((n) => ({
      ...n,
      position: { ...n.position },
    }));

    if (key === lastCanvasLayoutKeyRef.current) return;
    lastCanvasLayoutKeyRef.current = key;

    const slots = computeSlots(canvasRootIds, layoutBaseNodes, structuralEdges);

    // ✅ Move ALL subtrees in ONE setNodes() so fitView runs AFTER everything moved
    const shifts = new Map<string, { dx: number; dy: number }>();

    for (let i = 0; i < canvasRootIds.length; i++) {
      const rootId = canvasRootIds[i];
      const slot = slots[i];
      if (!slot) continue;

      const ids = getSubtreeIdsLocal(rootId, structuralEdges);
      const subset = layoutBaseNodes.filter((n) => ids.has(n.id));
      if (subset.length === 0) continue;

      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;

      for (const n of subset) {
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + nodeWidth);
        maxY = Math.max(maxY, n.position.y + nodeHeight);
      }

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      const dx = slot.x - cx;
      const dy = slot.y - cy;

      // store shift for this root
      shifts.set(rootId, { dx, dy });
   }

    setNodes((prev) =>
      prev.map((n) => {
        // find which open root this node belongs to (first match)
        for (let i = 0; i < canvasRootIds.length; i++) {
          const rid = canvasRootIds[i];
          const ids = getSubtreeIdsLocal(rid, structuralEdges);
          if (!ids.has(n.id)) continue;

          const s = shifts.get(rid);
          if (!s) return n;

          if (Math.abs(s.dx) < 0.5 && Math.abs(s.dy) < 0.5) return n;
          return { ...n, position: { x: n.position.x + s.dx, y: n.position.y + s.dy } };
        }
        return n;
      })
    );

    setLayoutTick((t) => t + 1);

    // 🚫 Never auto-fit on initial load (but DO mark that initial layout has happened)
    if (!didInitialCanvasLayoutRef.current) {
      didInitialCanvasLayoutRef.current = true;

      // If viewport restore was in progress, consume it.
      if (didRestoreViewportRef.current) {
        didRestoreViewportRef.current = false;
      }

      return; // skip auto-fit on first pass only
    }
 
    // 🚫 If viewport was restored, don't override it
    if (didRestoreViewportRef.current) {
      didRestoreViewportRef.current = false;
      return;
    }

    // ✅ Only user-driven changes later may auto-fit
    scheduleAutoFit();
  }, [rfInstance, canvasRootIds, structuralEdges]);

  useEffect(() => {
    if (!rfInstance) return;
    if (!nodesInitialized) return;
    if (canvasRootIds.length === 0) return;
  }, [rfInstance, nodesInitialized, canvasRootIds, scheduleAutoFit])

  // --- Grid layout (runs ONLY when "which maps are open" changes) ---
 /* const lastGridKeyRef = useRef<string>("");

  useEffect(() => {
    if (!rfInstance) return;
    if (nodes.length === 0) return;

    const incoming = new Set(edges.map((e) => e.target));
    const roots = nodes.filter((n) => !incoming.has(n.id));
    const mainRoot = roots.find((r) => !isImportedRootNode(r)) ?? roots[0] ?? null;
    if (!mainRoot) return;

    const selected = selectedMapRootIds
      .filter((id) => id !== mainRoot.id)
      .slice(0, MAX_EXTRA_MAPS);

    // Only re-run layout when the "open roots" set changes
    const gridKey = `${mainRoot.id}|${selected.join(",")}|roots:${roots.length}`;
    if (gridKey === lastGridKeyRef.current) return;
    lastGridKeyRef.current = gridKey;

    // Slot centers: crisp 2x2 grid
    const SLOT = {
      MAIN_SOLO: { x: 0, y: 0 },           // when nothing else open
      TL: { x: -700, y: -330 },            // top-left (main when others open)
      TR: { x: 700, y: -330 },             // top-right
      BL: { x: -700, y: 330 },             // bottom-left
      BR: { x: 700, y: 330 },              // bottom-right
    };

    // If only main map open: center it
    if (selected.length === 0) {
      moveSubtreeTo(mainRoot.id, SLOT.MAIN_SOLO.x, SLOT.MAIN_SOLO.y);

      const mainIds = getSubtreeIdsLocal(mainRoot.id, edges);
      const mainNodes = nodes.filter((n) => mainIds.has(n.id));

      // Fit view here (this also solves part of zoom issues)
      requestAnimationFrame(() => {
        rfInstance.fitView({
          nodes: mainNodes,
          padding: 0.25,
          duration: 450,
          minZoom: 0.8,
          maxZoom: 1.2,
        });

        // hard clamp for readability
        setTimeout(() => {
          const z = rfInstance.getZoom();
          if (z < 0.8) {
            const vp = rfInstance.getViewport();
            rfInstance.setViewport({ ...vp, zoom: 0.8 }, { duration: 200 });
          }
        }, 80);
      });

      return;
    }

    // When multiple maps open: main goes top-left and others fill remaining slots
    moveSubtreeTo(mainRoot.id, SLOT.TL.x, SLOT.TL.y);
    if (selected[0]) moveSubtreeTo(selected[0], SLOT.TR.x, SLOT.TR.y);
    if (selected[1]) moveSubtreeTo(selected[1], SLOT.BL.x, SLOT.BL.y);
    if (selected[2]) moveSubtreeTo(selected[2], SLOT.BR.x, SLOT.BR.y);

    // Fit visible nodes (main + selected)
    const keepIds = new Set<string>();
    for (const id of getSubtreeIdsLocal(mainRoot.id, edges)) keepIds.add(id);
    for (const rid of selected) for (const id of getSubtreeIdsLocal(rid, edges)) keepIds.add(id);

    const vis = nodes.filter((n) => keepIds.has(n.id));

    requestAnimationFrame(() => {
      rfInstance.fitView({
        nodes: vis,
        padding: 0.25,
        duration: 450,
        minZoom: 0.8,
        maxZoom: 1.2,
      });

      setTimeout(() => {
        const z = rfInstance.getZoom();
        if (z < 0.8) {
          const vp = rfInstance.getViewport();
          rfInstance.setViewport({ ...vp, zoom: 0.8 }, { duration: 200 });
        }
      }, 80);
    });
  }, [rfInstance, selectedMapRootIds, nodes.length, edges.length, moveSubtreeTo, nodes, edges]); */

  const handleSummarizeMindMap = useCallback(async () => {
    if (!mindMapId) return;

    const rootNodeId = pickRootForAi("summarize");
    if (!rootNodeId) return;

    try {
      setSummaryLoading(true);
      setSummaryError(null);

      const res = await fetch(
        `${API_BASE}/api/MindMaps/${mindMapId}/summary?rootNodeId=${encodeURIComponent(rootNodeId)}`,
        { method: "POST", headers: { Accept: "application/json" } }
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Summary failed (${res.status})${text ? `: ${text}` : ""}`);
      }

      const data = await res.json();
      setSummaryText(data.summary ?? "");
    } catch (err: any) {
      console.error(err);
      setSummaryError(err.message ?? "Summary failed");
    } finally {
      setSummaryLoading(false);
    }
  }, [mindMapId, pickRootForAi]);

const handleGenerateAiEdges = useCallback(
  async () => {
    if (!mindMapId) return;

    try {
      setAiLoading(true);
      setError(null);
      setAiEdges([]);
      setAiInfo(null);

      const res = await fetch(
        `${API_BASE}/api/graph/mindmaps/${mindMapId}?minScore=${AI_MIN_SCORE}&maxEdgesPerNode=${AI_MAX_EDGES_PER_NODE}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        }
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `AI relationships failed (${res.status})${text ? `: ${text}` : ""}`
        );
      }

      const data: AiGraphResponseDto = await res.json();
      console.log("AI graph response", data);

      const edgesFromApi = (data.edges ?? []) as any[];

      if (!edgesFromApi || edgesFromApi.length === 0) {
        const msg =
          "AI relationships: backend returned no edges. It might need more node content.";
        setError(msg);
        setAiInfo(msg);
        return;
      }

      const nodeIds = new Set(nodes.map((n) => n.id));

      const newEdges: Edge[] = edgesFromApi
        .map((edge) => {
          const src =
            edge.sourceId ??
            edge.source ??
            edge.fromNodeId ??
            edge.fromId;
          const tgt =
            edge.targetId ??
            edge.target ??
            edge.toNodeId ??
            edge.toId;

          const score =
            edge.score ??
            edge.similarity ??
            edge.weight ??
            0;

          if (!src || !tgt) return null;
          // extra safety: also filter locally by score
          if (typeof score === "number" && score < AI_MIN_SCORE) return null;
          if (!nodeIds.has(src) || !nodeIds.has(tgt)) return null;

          return {
            id: `ai-${src}-${tgt}`,
            source: src,
            target: tgt,
            type: "smoothstep",
            animated: true,
            style: {
              stroke: "#ef4444", // AI = red
              strokeWidth: 4,
              opacity: 0.85,
            },
            label: "AI",
            labelStyle: {
              fontSize: 10,
              fill: "#111827",
            },
            labelBgStyle: {
              fill: "#fee2e2",
              stroke: "#fecaca",
            },
            labelBgPadding: [3, 4],
            labelBgBorderRadius: 4,
            data: {
              aiSuggested: true,
              score,
            },
          } as Edge;
        })
        .filter((e): e is Edge => !!e);

      if (newEdges.length === 0) {
        const msg =
          "AI relationships: backend edges did not match any node IDs in this map.";
        setError(msg);
        setAiInfo(msg);
      } else {
        setAiEdges(newEdges);
        setAiInfo(
          `AI relationships: showing ${newEdges.length} suggested connections.`
        );
      }
    } catch (err: any) {
      console.error(err);
      const msg = err.message ?? "Failed to generate AI relationships";
      setError(msg);
      setAiEdges([]);
      setAiInfo(msg);
    } finally {
      setAiLoading(false);
    }
  },
  [mindMapId, nodes]
);

  const handleNewMap = useCallback(async () => {
    try {
      if (!rfInstance) return;

      // If canvas is full, still allow creating, but keep it library-only
      const willOpenOnCanvas = canvasRootIds.length < 4;

      const center = rfInstance.project({
        x: window.innerWidth / 2 - 200,
        y: window.innerHeight / 2 - 200,
      });

      const newRoot: Partial<MindMapNodeDto> = {
        mindMapId,
        label: "New Map",
        positionX: center.x,
        positionY: center.y,
        parentId: null,
      };

      const res = await fetch(`${API_BASE}/api/MindMapNodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newRoot),
      });

      if (!res.ok) throw new Error(`Failed to create new map (${res.status})`);
      const created: MindMapNodeDto = await res.json();

      // Refresh graph
      await fetchNodes();

      // Add to library
      setLibraryRootIds((prev) => Array.from(new Set([...prev, created.id])));

      // Add to canvas if slot exists
      if (willOpenOnCanvas) {
        setCanvasRootIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id].slice(0, 4)));
        setActiveCanvasRootId(created.id);
        setLimitNotice(null);
      } else {
        setLimitNotice("Canvas limit is 4 maps. New map was created in the library. Close or replace a map to open it.");
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to create new map");
    }
  }, [rfInstance, mindMapId, fetchNodes, canvasRootIds]);

  const handleAddNode = useCallback(async () => {
    try {
      if (!rfInstance) return;
      if (!activeCanvasRootId) {
        setError("Select/Open a map on canvas first (max 4).");
        return;
      }

      recordSnapshot();

      const center = rfInstance.project({
        x: window.innerWidth / 2 - 200,
        y: window.innerHeight / 2 - 200,
      });

      const newNode: Partial<MindMapNodeDto> = {
        mindMapId,
        label: "New idea",
        parentId: activeCanvasRootId,
        positionX: center.x,
        positionY: center.y,
      };

      const res = await fetch(`${API_BASE}/api/MindMapNodes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(newNode),
      });

      if (!res.ok) {
        throw new Error(`Failed to create node (${res.status})`);
      }

      const created: MindMapNodeDto = await res.json();

      const rfNode: Node<NodeData> = {
        id: created.id,
        type: "ovalNode",
        position: { x: safeNum(created.positionX), y: safeNum(created.positionY) },
        data: { label: created.label ?? created.text ?? "" },

        // ✅ REQUIRED so MiniMap SVG never gets NaN
        width: nodeWidth,
         height: nodeHeight,
      };

      setNodes((prev) => [...prev, rfNode]);
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to add node");
    }
  }, [mindMapId, rfInstance, recordSnapshot, activeCanvasRootId]);

  const handleDeleteSelected = useCallback(async () => {
  if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return;

  try {
    recordSnapshot();

    // 1) Delete selected nodes via API
    // Persist edge deletions: set child.parentId = null for each deleted edge
    await Promise.all(
      edges
        .filter((e) => selectedEdgeIds.includes(e.id))
        .map(async (e) => {
          const child = nodes.find((n) => n.id === e.target);
          if (!child) return;

          const updatedDto: Partial<MindMapNodeDto> = {
            id: e.target,
            mindMapId,
            parentId: null,
            positionX: child.position.x,
            positionY: child.position.y,
            label: child.data?.label ?? "",
          };

          const res = await fetch(`${API_BASE}/api/MindMapNodes/${e.target}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updatedDto),
          });

          if (!res.ok) {
            console.error(`Failed to detach child ${e.target}`, await res.text().catch(() => ""));
          }
        })
    );


    // 2) Remove deleted nodes' edges + any explicitly selected edges
    setNodes((prev) => prev.filter((n) => !selectedNodeIds.includes(n.id)));
    setEdges((prev) =>
      prev.filter(
        (e) =>
          !selectedNodeIds.includes(e.source) &&
          !selectedNodeIds.includes(e.target) &&
          !selectedEdgeIds.includes(e.id)
      )
    );

    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
  } catch (err: any) {
    console.error(err);
    setError(err.message ?? "Failed to delete selected items");
  }
}, [selectedNodeIds, selectedEdgeIds, recordSnapshot]);

  const handleDeleteMindMap = useCallback(async () => {
    if (!mindMapId) return;

    const ok = window.confirm(
      "Delete this entire mind map? This cannot be undone."
    );
    if (!ok) return;

    try {
      const res = await fetch(`${API_BASE}/api/MindMaps/${mindMapId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Failed to delete mind map (${res.status})${text ? `: ${text}` : ""}`);
      }

      window.location.href = "/mindmaps";
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to delete mind map");
    }
  }, [mindMapId]);

  const handleRenameNodeFromMenu = useCallback(
    async (nodeId: string) => {
      hideContextMenu();

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      const newLabel = window.prompt("Enter new label", node.data.label);
      if (!newLabel || newLabel.trim() === node.data.label) return;

      try {
        recordSnapshot();

        const updatedDto: Partial<MindMapNodeDto> = {
          id: nodeId,
          mindMapId,
          label: newLabel.trim(),
          positionX: node.position.x,
          positionY: node.position.y,
          parentId: getParentId(nodeId),
        };

        const res = await fetch(`${API_BASE}/api/MindMapNodes/${nodeId}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updatedDto),
        });

        if (!res.ok) {
          throw new Error(`Failed to rename node (${res.status})`);
        }

        setNodes((prev) =>
          prev.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: { ...n.data, label: newLabel.trim() },
                }
              : n
          )
        );
      } catch (err: any) {
        console.error(err);
        setError(err.message ?? "Failed to rename node");
      }
    },
    [nodes, mindMapId, recordSnapshot, getParentId, hideContextMenu]
  );

  const handleAddChildNode = useCallback(
    async (parentId: string) => {
      hideContextMenu();

      try {
        if (!rfInstance) return;

        recordSnapshot();

        const parentNode = nodes.find((n) => n.id === parentId);
        if (!parentNode) return;

        const newNode: Partial<MindMapNodeDto> = {
          mindMapId,
          label: "New child idea",
          parentId,
          positionX: parentNode.position.x + 220,
          positionY: parentNode.position.y + 140,
        };

        const res = await fetch(`${API_BASE}/api/MindMapNodes`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(newNode),
        });

        if (!res.ok) {
          throw new Error(`Failed to create child node (${res.status})`);
        }

        const created: MindMapNodeDto = await res.json();

        const rfNode: Node<NodeData> = {
          id: created.id,
          type: "ovalNode",
          position: { x: created.positionX, y: created.positionY },
          data: { label: created.label ?? created.text ?? "" },
        };

        const rfEdge: Edge = {
          id: `${parentId}-${created.id}`,
          source: parentId,
          target: created.id,
          type: "smoothstep",
          animated: false,
          style: EDGE_STYLE,
        };

        setNodes((prev) => [...prev, rfNode]);
        setEdges((prev) => [...prev, rfEdge]);
      } catch (err: any) {
        console.error(err);
        setError(err.message ?? "Failed to add child node");
      }
    },
    [mindMapId, nodes, rfInstance, recordSnapshot, hideContextMenu]
  );

  const handleUndo = useCallback(() => {
    if (!canUndo) return;

    setHistory((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;

      setFuture((f) => [
        ...f,
        {
          nodes: cloneNodes(nodes),
          edges: cloneEdges(edges),
        },
      ]);

      setNodes(cloneNodes(last.nodes));
      setEdges(cloneEdges(last.edges));

      return prev.slice(0, -1);
    });
  }, [canUndo, nodes, edges]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;

    setFuture((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;

      setHistory((h) => [
        ...h,
        {
          nodes: cloneNodes(nodes),
          edges: cloneEdges(edges),
        },
      ]);

      setNodes(cloneNodes(last.nodes));
      setEdges(cloneEdges(last.edges));

      return prev.slice(0, -1);
    });
  }, [canRedo, nodes, edges]);

  const handleAutoLayout = useCallback(() => {
    recordSnapshot();

    const layouted = getLayoutedElements(nodes, edges, "TB");
    setNodes(layouted.nodes);
    setEdges(layouted.edges);
  }, [nodes, edges, recordSnapshot]);

  const handleFitView = useCallback(() => {
    if (!rfInstance) return;

    rfInstance.fitView({ padding: 0.3 });

    // ✅ IMPORTANT: persist the programmatic viewport change
    // (fitView often doesn't fire onMoveEnd)
    persistViewportSoon(60);
  }, [rfInstance, persistViewportSoon]);

  const highlightEvidenceNodes = useCallback(
    (ids: string[]) => {
      const clean = Array.from(new Set((ids ?? []).filter(Boolean)));

      if (clean.length === 0) return;

      // 1) highlight
      setAiSourceNodes(clean);

      // 2) zoom to those nodes so user can SEE the highlight
      // Use a small delay so ReactFlow receives the updated nodes first
      setTimeout(() => {
        if (!rfInstance) return;

        const targets = nodes.filter((n) => clean.includes(n.id));
        if (targets.length === 0) return;

        rfInstance.fitView({
          nodes: targets,
          padding: 0.35,
          duration: 600,
        });
      }, 60);
    },
    [rfInstance, nodes]
  );

  const handleClearHighlights = useCallback(() => {
    setLockedHighlightNodeIds([]);
    setPreviewHighlightNodeIds([]);
    setAiSourceNodes([]);
    setActiveSentenceIndex(null);
    setFocusedSourceId(null);
  }, []);


  const mergeUnique = (a: string[], b: string[]) =>
    Array.from(new Set([...(a ?? []), ...(b ?? [])]));

  const applyHighlights = useCallback((locked: string[], preview: string[]) => {
    setAiSourceNodes(mergeUnique(locked, preview));
  }, []);

  useEffect(() => {
    applyHighlights(lockedHighlightNodeIds, previewHighlightNodeIds);
  }, [lockedHighlightNodeIds, previewHighlightNodeIds, applyHighlights]);

  const blinkNodes = useCallback((nodeIds: string[]) => {
    if (nodeIds.length === 0) return;

    // simple blink by toggling a CSS class via DOM query (fast + minimal state)
    nodeIds.forEach((id) => {
      const el = document.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
      if (el) {
        el.classList.remove("mm-blink");
        // force reflow so re-adding re-triggers animation
        void el.offsetWidth;
        el.classList.add("mm-blink");
        setTimeout(() => el.classList.remove("mm-blink"), 650);
      }
    });
  }, []);

  const onInit = useCallback(
    (instance: any) => {
      setRfInstance(instance);

      // restore saved viewport (prevents refresh jump)
      try {
        const raw = localStorage.getItem(VIEWPORT_STATE_KEY);
        if (raw) {
          const vp = JSON.parse(raw);
          if (
            vp &&
            Number.isFinite(vp.x) &&
            Number.isFinite(vp.y) &&
            Number.isFinite(vp.zoom)
          ) {
            didRestoreViewportRef.current = true;
            blockAutoFitRef.current = true; // block fitView calls for a moment
            instance.setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom }, { duration: 0 });

            // unblock shortly after mount settles
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                blockAutoFitRef.current = false;
              });
            });
          }
        }
      } catch {
        // ignore
      }
    },
    [VIEWPORT_STATE_KEY]
  );

  const onPaneClick = useCallback(() => {
    hideContextMenu();

    // close panels
    setIsNodeDetailsOpen(false);
    setNodeDetailsNodeId(null);

    // ✅ clear selection state (so Delete disables instantly)
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);

    // ✅ also clear ReactFlow internal selected flags
    setNodes((prev) => prev.map((n) => ({ ...n, selected: false })));
    setEdges((prev) => prev.map((e) => ({ ...e, selected: false })));
  }, [hideContextMenu]);

  const streamRef = useRef<HTMLDivElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;

    el.scrollTo({
      top: el.scrollHeight,
      behavior: "smooth",
    });
  }, [chatAnswer, chatLoading]);


  const summaryLines = formatSummaryText(summaryText);
  const MAX_SUMMARY_NODES = 10;

  const highlightedNodes = nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      highlighted: aiSourceNodes.includes(n.id),
    },
  }));

  const styledEdges = [...edges, ...aiEdges].map((e) => {
    const isActive = e.id === activeEdgeId;

    // ✅ NEW: selected edge highlight (for easy delete)
    const isSelected =
      selectedEdgeIds.includes(e.id) || (e as any).selected === true;

    const isEvidenceEdge =
      aiSourceNodes.includes(e.source) || aiSourceNodes.includes(e.target);

    const isImportConn = (e.data as any)?.kind === "import-connection";

    return {
      ...e,
      interactionWidth: (e.data as any)?.kind === "import-connection" ? 22 : 16,
      style: {
        ...(e.style ?? {}),
        // ---- IMPORT-CONNECTION (green dashed) ----
        ...(isImportConn
          ? {
              stroke: (isSelected || isActive) ? "#16a34a" : "#22c55e",
              strokeWidth: (isSelected || isActive) ? 5 : 2.5,
              opacity: (isSelected || isActive) ? 1 : 0.9,
              strokeDasharray: (isSelected || isActive) ? undefined : "6 6",
            }
          : {}),

        // ---- NORMAL TREE EDGES (grey) ----
        ...(!isImportConn
          ? {
              // keep your existing stroke if present, otherwise fallback
              stroke:
                (isSelected || isActive)
                  ? "#0ea5e9" // blue highlight on hover/selected
                  : ((e.style as any)?.stroke ?? "#4b5563"),

              strokeWidth:
                (isSelected || isActive)
                  ? 4
                  : ((e.style as any)?.strokeWidth ?? 2.4),

              opacity:
                (isSelected || isActive)
                  ? 1
                  : ((e.style as any)?.opacity ?? 1),
            }
          : {}),
      },
    };
  });

  const visibleGraph = useMemo(() => {
    const keep = new Set<string>();

    for (const rid of canvasRootIds) {
    for (const id of getSubtreeIdsLocal(rid, edges.filter(isStructuralEdge))) keep.add(id);
    }

    // ✅ Always show highlighted nodes (so evidence highlighting is visible)
    for (const id of aiSourceNodes) keep.add(id);

    // ✅ Also keep endpoints of import-connection edges if one end is already visible.
    // This ensures the green dashed connection lines actually show.
    for (const e of styledEdges) {
      const isImportConn = (e.data as any)?.kind === "import-connection";
      if (!isImportConn) continue;

      if (keep.has(e.source) || keep.has(e.target)) {
        keep.add(e.source);
        keep.add(e.target);
      }
    }

    const visNodes = highlightedNodes.map((n) => ({
      ...n,
      position: {
        x: Number.isFinite(n.position?.x) ? n.position.x : 0,
        y: Number.isFinite(n.position?.y) ? n.position.y : 0,
      },

      // ✅ IMPORTANT: MiniMap uses numeric width/height (not CSS) for SVG math
      width: nodeWidth,
      height: nodeHeight,

      // keep your styling if you want
      style: {
        ...(n.style ?? {}),
      },

      hidden: !keep.has(n.id),
    }));

    const visEdges = styledEdges.map((e) => ({
      ...e,
      hidden: !keep.has(e.source) || !keep.has(e.target),
    }));

    return { visNodes, visEdges };
  }, [highlightedNodes, styledEdges, canvasRootIds, edges, aiSourceNodes]);


  const allMaps = useMemo(() => {
    // imported root -> filename
    const importedNameByRoot = new Map(importedBranches.map((b) => [b.rootNodeId, b.fileName] as const));

    return libraryRootIds
      .map((rootId) => {
        const importedName = importedNameByRoot.get(rootId);
        const createdName =
          nodes.find((n) => n.id === rootId)?.data?.label ||
          `Map ${rootId.slice(0, 8)}…`;

        return {
          rootId,
          title: importedName || createdName,
          origin: importedName ? "Imported" : "Created",
          onCanvas: canvasRootIds.includes(rootId),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [libraryRootIds, importedBranches, nodes, canvasRootIds]);

  const svgOverlaysOk = useMemo(() => {
    if (!rfInstance) return false;
    const vp = rfInstance.getViewport?.();
    if (!vp) return false;
    return Number.isFinite(vp.x) && Number.isFinite(vp.y) && Number.isFinite(vp.zoom);
  }, [rfInstance, nodes.length, edges.length]);

  return (
    <div className="mindmap-page">
      {/* Always-mounted hidden file input so picker works every time */}
        <input
          ref={importFileInputRef}
          id="mindmap-import-file"
          type="file"
          accept=".txt,.md,.pdf"
          disabled={importing}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImportFile(f);
            e.currentTarget.value = "";
          }}
        />

      <div className="mindmap-header">
        <div className="flex flex-col gap-1">
          <div className="text-xs text-slate-500 mb-1">
            Mind Map Editor (ID: {mindMapId})
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DisabledHint disabled={!canUndo} tip="Nothing to undo yet.">
              <Button
                variant="outline"
                size="sm"
                onClick={handleUndo}
                disabled={!canUndo}
              >
                Undo
              </Button>
            </DisabledHint>

            <DisabledHint disabled={!canRedo} tip="Nothing to redo yet.">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRedo}
                disabled={!canRedo}
              >
                Redo
              </Button>
            </DisabledHint>

            <Separator orientation="vertical" className="h-6" />
            <Button variant="default" size="sm" onClick={handleAddNode}>
              + Add node
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowChatPanel(true);
                importFileInputRef.current?.click(); // must be sync (no requestAnimationFrame)
              }}
            >
              Import file
            </Button>

            <DisabledHint
              disabled={selectedNodeIds.length === 0 && selectedEdgeIds.length === 0}
              tip="Select a node or an edge first."
            >
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteSelected}
                disabled={selectedNodeIds.length === 0 && selectedEdgeIds.length === 0}
              >
                Delete selected
              </Button>
            </DisabledHint>

            <Separator orientation="vertical" className="h-6" />
            <DisabledHint disabled={loading} tip="Please wait for the map to finish loading.">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={`inline-flex ${loading ? "cursor-not-allowed" : ""}`} tabIndex={0}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleAutoLayout}
                      disabled={loading}
                    >
                      Auto-layout
                    </Button>
                  </span>
                </TooltipTrigger>
                {!loading && (
                  <TooltipContent
                    side="bottom"
                    sideOffset={8}
                    className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow"
                  >
                    Arrange the maps into a clean grid automatically.
                  </TooltipContent>
                )}
              </Tooltip>
            </DisabledHint>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={handleFitView}>
                  Fit view
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                sideOffset={8}
                className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow"
              >
                Zoom and pan to fit all visible maps on the screen.
              </TooltipContent>
            </Tooltip>

            <DisabledHint disabled={aiLoading} tip="AI is already finding relationships… please wait.">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={`inline-flex ${aiLoading ? "cursor-not-allowed" : ""}`} tabIndex={0}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleGenerateAiEdges}
                      disabled={aiLoading}
                    >
                      {aiLoading ? "Finding relationships…" : "AI relationships"}
                    </Button>
                  </span>
                </TooltipTrigger>
                {!aiLoading && (
                  <TooltipContent
                    side="bottom"
                    sideOffset={8}
                    className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow"
                  >
                    Suggest cross-map relationships using AI / similarity.
                  </TooltipContent>
                )}
              </Tooltip>
            </DisabledHint>

            <Separator orientation="vertical" className="h-6" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowSummaryPanel((s) => !s)}
                >
                  {showSummaryPanel ? "Hide summary" : "Show summary"}
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                sideOffset={8}
                className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow"
              >
                Toggle the summary panel.
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowChatPanel((s) => !s)}
                >
                  {showChatPanel ? "Hide Ask AI" : "Show Ask AI"}
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                sideOffset={8}
                className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow"
              >
                Ask questions about this mind map and get AI answers.
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowImportsPanel((s) => !s)}
                >
                  {showImportsPanel ? "Hide imports" : "Show imports"}
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                sideOffset={8}
                className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow"
              >
                View imported files / branches and run Find connections.
              </TooltipContent>
            </Tooltip>

            <DisabledHint disabled={!showRelatedPanel} tip="No Related Ideas panel is open right now.">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRelatedPanel(false)}
                disabled={!showRelatedPanel}
              >
                Hide related
              </Button>
            </DisabledHint>

            <DisabledHint disabled={!isNodeDetailsOpen} tip="Select a single node to open Node details first.">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsNodeDetailsOpen(false);
                  setNodeDetailsNodeId(null);
                }}
                disabled={!isNodeDetailsOpen}
              >
                Hide details
              </Button>
            </DisabledHint>

            <DisabledHint disabled={aiSourceNodes.length === 0} tip="No highlighted nodes to clear.">
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearHighlights}
                disabled={aiSourceNodes.length === 0}
              >
                Clear highlights
              </Button>
            </DisabledHint>

          </div>
        </div>

        <form
          onSubmit={handleSearch}
          className="flex items-center gap-2 min-w-[320px]"
        >
          <Input
            placeholder="Semantic search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="text-sm"
          />
          <Button
            type="submit"
            size="sm"
            disabled={searching || !searchQuery.trim()}
          >
            {searching ? "Searching…" : "Search"}
          </Button>
        </form>
      </div>

      {error && (
        <div className="px-4 py-2 text-sm text-red-600 bg-red-50 border-b border-red-200">
          {error}
        </div>
      )}

      {importError && (
        <div className="px-4 py-2 text-sm text-red-600 bg-red-50 border-b border-red-200">
          {importError}
        </div>
      )}

      {importOk && (
        <div className="px-4 py-2 text-sm text-emerald-700 bg-emerald-50 border-b border-emerald-200">
          {importOk}
        </div>
      )}

      {aiInfo && !error && (
        <div className="px-4 py-2 text-xs text-sky-800 bg-sky-50 border-b border-sky-200">
          {aiInfo}
        </div>
      )}

      {limitNotice && (
        <div className="px-4 py-2 text-sm text-amber-800 bg-amber-50 border-b border-amber-200">
          {limitNotice}
        </div>
      )}

      <div
        className="mindmap-body"
        onClick={hideContextMenu}
        style={{ height: "calc(100vh - 180px)" }}
      >
          {loading ? (
            <div className="flex items-center justify-center h-full text-slate-500">
              Loading mind map...
            </div>
          ) : nodes.length === 0 ? (
            <div className="flex items-center justify-center h-full px-6">
              <div className="max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="text-base font-semibold text-slate-900">
                  This mind map is empty
                </div>
              <div className="mt-2 text-sm text-slate-600">
                Start by adding your first idea, or import a document to generate a tree automatically.
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" onClick={handleNewMap}>
                  + New map
                </Button>
                <Button size="sm" variant="outline" onClick={handleAddNode}>
                  + Add node
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowChatPanel(true);
                    importFileInputRef.current?.click();
                  }}
                >
                  Import file
                </Button>
              </div>

              <div className="mt-3 text-xs text-slate-500">
                Tip: Open <span className="font-medium">Ask AI</span> →{" "}
                <span className="font-medium">Import file</span> to upload .txt/.md/.pdf.
              </div>
            </div>
          </div>
        ) : (
            <ReactFlow
              nodes={visibleGraph.visNodes}
              edges={visibleGraph.visEdges.filter((e) => !(e as any).hidden)}
              onEdgeMouseEnter={(_, edge) => setActiveEdgeId(edge.id)}
              onEdgeMouseLeave={() => setActiveEdgeId(null)}
              onEdgeClick={(_, edge) => {
                setActiveEdgeId(edge.id);

                // mark this edge selected (so Delete selected works predictably)
                setSelectedEdgeIds([edge.id]);
                setSelectedNodeIds([]);

                // keep ReactFlow's internal selected flags in sync
                setEdges((prev) => prev.map((e) => ({ ...e, selected: e.id === edge.id })));
                setNodes((prev) => prev.map((n) => ({ ...n, selected: false })));
              }}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
              onInit={onInit}
              onNodeClick={(_, node) => setSelectedNodeIds([node.id])}
              onSelectionChange={onSelectionChange}
              onNodeContextMenu={onNodeContextMenu}
              onPaneClick={onPaneClick}
              onMoveEnd={() => {
                if (blockAutoFitRef.current) return;
                if (!rfInstance) return;

                const vp = rfInstance.getViewport?.();
                if (!vp) return;

                try {
                  localStorage.setItem(VIEWPORT_STATE_KEY, JSON.stringify(vp));
                } catch {}
              }}
              nodeTypes={nodeTypes}
              minZoom={0.2}
              maxZoom={1.8}
              defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
              onNodeDragStop={async (_e, node) => {
                try {
                  const parentId = getParentId(node.id);

                  const res = await fetch(`${API_BASE}/api/MindMapNodes/${node.id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                    id: node.id,
                    mindMapId,
                    parentId,
                    label: node.data?.label ?? "",
                    positionX: node.position.x,
                    positionY: node.position.y,
                  }),
                }); 

                if (!res.ok) {
                  console.error("Failed to persist node position", await res.text().catch(() => ""));
                }
              } catch (err) {
                console.error("Failed to persist node position", err);
              }
            }}
          >
            {svgOverlaysOk && (
              <>
                <MiniMap />
                <Controls showInteractive={false} />
                <Background gap={16} size={1} />
              </> 
            )}

            {aiEdges.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  right: 16,
                  top: 16,
                  padding: "4px 8px",
                  borderRadius: 9999,
                  fontSize: 10,
                  background: "rgba(15,23,42,0.85)",
                  color: "white",
                  zIndex: 20,
                }}
              >
                Red animated lines labelled “AI” = AI relationships
              </div>
            )}
          </ReactFlow>
        )}
      </div>

      {/* Related Ideas Panel */}
      {showRelatedPanel && relatedNodes.length > 0 && (
        <div
          className="absolute right-5 z-40 w-80 max-h-[70vh]"
          style={{ top: isNodeDetailsOpen ? 360 : 96 }}
        >
          <Card className="shadow-lg border-slate-200 h-full flex flex-col">
            <CardHeader className="py-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">
                Related Ideas
              </CardTitle>
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-slate-600"
                onClick={() => setShowRelatedPanel(false)}
              >
                ✕
              </button>
            </CardHeader>
            <CardContent className="pt-2 flex-1">
              <ScrollArea className="h-full pr-2">
                <ul className="space-y-2 text-sm">
                  {relatedNodes.map((r, idx) => {
                    const nodeId = r.nodeId;
                    const anyObj = r as any;

                    const backendLabel =
                      (anyObj.label as string | undefined) ??
                      (anyObj.text as string | undefined) ??
                      (anyObj.content as string | undefined);

                    const fallbackLabel = getNodeLabel(nodeId);

                    const title =
                      (r.title && r.title.trim()) ||
                      (backendLabel && backendLabel.trim()) ||
                      fallbackLabel ||
                      "Related idea";

                    const excerpt =
                      r.excerpt ??
                      (anyObj.excerpt as string | undefined) ??
                      undefined;

                    return (
                      <li
                        key={nodeId ?? idx}
                        className="p-2 rounded-md hover:bg-slate-50 cursor-pointer border border-slate-100"
                        onClick={() => {
                          if (!nodeId) return;
                          handleSourceClick(nodeId);
                          setLockedHighlightNodeIds([nodeId]);
                          blinkNodes([nodeId]);
                        }}
                      >
                        <div className="font-medium text-xs mb-1">
                          {title}
                        </div>

                        {typeof (r as any).similarity === "number" && (
                          <div className="text-[10px] text-slate-500">
                            {((r as any).similarity >= 0.60) ? "Strong" : "Medium"} • {((r as any).similarity).toFixed(2)}
                          </div>
                        )}

                        {excerpt && (
                          <div className="text-[11px] text-slate-500">
                            {excerpt}
                          </div>
                        )}
                        {nodeId && (
                          <div className="mt-1 text-[10px] text-slate-400">
                            Click to open node ({nodeId.slice(0, 8)}…)
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      )}

      {evidencePanel.open && (
        <div className="absolute right-5 bottom-5 z-50 w-[420px] pointer-events-auto">
          <Card className="shadow-lg border-slate-200 max-h-[60vh] flex flex-col">
            <CardHeader className="py-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">
                Evidence details
              </CardTitle>
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-slate-600"
                onClick={() =>
                  setEvidencePanel({ open: false, sentenceIndex: null, sentence: null, items: [] })
                }
              >
                ✕
              </button>
            </CardHeader>

            <CardContent className="pt-0 flex flex-col gap-3 overflow-hidden">
              {evidencePanel.sentence && (
                <div className="rounded-md bg-slate-50 border border-slate-200 p-2 text-xs text-slate-700">
                  <div className="font-semibold mb-1">Sentence</div>
                  <div>{evidencePanel.sentence}</div>
                </div>
              )}

            <ScrollArea className="max-h-[40vh] pr-2">
              <div className="space-y-2">
                {evidencePanel.items.map((e, idx) => (
                  <div
                    key={`${e.nodeId}-${idx}`}
                    className="rounded-md border border-slate-200 bg-white p-2"
                  >
                    <div className="text-[11px] text-slate-500 flex items-center justify-between">
                      <span>Node: {e.nodeId?.slice(0, 8)}…</span>
                      <span>score: {(e.score ?? 0).toFixed(2)}</span>
                    </div>

                    <div className="mt-1 text-sm text-slate-800">
                      {e.textSpan}
                    </div>

                    {e.nodeId && (
                      <div className="mt-2 flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            handleSourceClick(e.nodeId!);
                            setLockedHighlightNodeIds([e.nodeId!]);
                            blinkNodes([e.nodeId!]);
                          }}
                        >
                          Open node
                        </Button>
                      </div>
                    )}

                    {e.nodeId && (
                      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700 whitespace-pre-wrap">
                        {(() => {
                          const full = getFullNodeText(e.nodeId);
                          return full || "This node has no saved text/content (only an ID).";
                        })()}
                      </div>
                    )}

                  </div>
                ))}
              </div>
            </ScrollArea>

            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={handleClearHighlights}
              >
                Clear highlights
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )}
  
      {/* Node details (shows full text for selected node) */}
      {isNodeDetailsOpen && nodeDetailsNodeId && (
        <div className="fixed right-6 top-24 z-50 w-[420px] max-w-[90vw] rounded-2xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 p-4">
            <div>
              <div className="text-sm font-semibold text-slate-800">Node details</div>
              <div className="text-xs text-slate-500">Full content (not truncated)</div>
            </div>

            <button
              className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100"
              onClick={() => {
                setIsNodeDetailsOpen(false);
                setNodeDetailsNodeId(null);
              }}
              aria-label="Close"
              title="Close"
            >
              ✕
            </button>
          </div>

          <div className="p-4">
            <div className="mb-2 text-xs text-slate-500">
              Node: <span className="font-mono">{nodeDetailsNodeId.slice(0, 8)}…</span>
            </div>

            <div className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-900">
              {getFullNodeText(nodeDetailsNodeId)}
            </div>
          </div>
        </div>
      )}

      {/* AI summary panel */}
      {showSummaryPanel && (
        <div className="fixed left-5 bottom-5 z-40 w-[560px] max-w-[92vw] pointer-events-auto">
          <Card className="shadow-lg border-slate-200 max-h-[75vh] flex flex-col">
            <CardHeader className="py-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">
                AI summary of this mind map
              </CardTitle>
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-slate-600"
                onClick={() => setShowSummaryPanel(false)}
              >
                ✕
              </button>
            </CardHeader>
            <CardContent className="pt-0 flex-1 flex flex-col gap-3 overflow-hidden">
              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleSummarizeMindMap}
                  disabled={summaryLoading}
                >
                  {summaryLoading && !summaryText
                    ? "Summarizing…"
                    : "Summarize map"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSummarizeMindMap}
                  disabled={summaryLoading || !summaryText}
                >
                  {summaryLoading && summaryText
                    ? "Regenerating…"
                    : "Regenerate"}
                </Button>
              </div>

              {summaryError && (
                <p className="text-xs text-red-500">{summaryError}</p>
              )}

              {summaryLines.length > 0 && (
                <>
                  <ScrollArea className="h-[40vh] pr-2">
                    <ul className="text-sm space-y-2">
                      {summaryLines.map((line, idx) => (
                        <li key={idx} className="flex">
                          <span className="mr-2">•</span>
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>

                  <Separator className="my-2" />

                  <div>
                    <div className="text-[11px] font-semibold text-slate-500 mb-1">
                      Nodes used in summary
                    </div>
                    <ScrollArea className="max-h-40 pr-2">
                      <ul className="text-[11px] space-y-1">
                        {nodes.slice(0, MAX_SUMMARY_NODES).map((n) => (
                          <li key={n.id} className="truncate">
                            • {n.data?.label}
                          </li>
                        ))}
                      </ul>
                      {nodes.length > MAX_SUMMARY_NODES && (
                        <div className="mt-1 text-[10px] text-slate-400">
                          + {nodes.length - MAX_SUMMARY_NODES} more nodes
                        </div>
                      )}
                    </ScrollArea>
                  </div>
                </>
              )}

              {!summaryText && !summaryLoading && !summaryError && (
                <p className="text-[11px] text-slate-500">
                  Click <span className="font-medium">Summarize map</span> to
                  generate a short AI-written overview of this mind map.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {showImportsPanel && (
        <div
          className="absolute right-5 top-24 z-40 w-80 max-h-[70vh] rounded-xl border border-slate-200 bg-white/95 shadow-lg backdrop-blur p-3"
          onClick={(e) => e.stopPropagation()}
          onMouseDownCapture={(e) => e.stopPropagation()}
          onWheelCapture={(e) => e.stopPropagation()}
        >
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <div className="text-sm font-semibold text-slate-800">Imports</div>
            <div className="text-xs text-slate-500">Imported files / branches in this map</div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowImportsPanel(false)}
            className="h-8 px-2"
          >
            Close
          </Button>
        </div>

        <div className="space-y-2 overflow-auto pr-1" style={{ maxHeight: "calc(70vh - 64px)" }}>
          {importedBranches.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <div className="font-semibold text-slate-800">No imports yet</div>
              <div className="mt-1 text-xs text-slate-600">
                Import a document to create a new branch and then use{" "}
                <span className="font-medium">Find connections</span> to link ideas across maps.
              </div>

              <div className="mt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowChatPanel(true);
                    importFileInputRef.current?.click();
                  }}
                >
                  Import file
                </Button>

              </div>
            </div>
          )}

          {importedBranches.map((b) => (
            <div key={b.rootNodeId} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-800 truncate">
                    {b.fileName}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    root: {b.rootNodeId.slice(0, 8)}… · nodes: {b.createdNodes}
                    {typeof b.connectionsAdded === "number" ? ` · links: ${b.connectionsAdded}` : ""}
                  </div>
                  {b.error && <div className="text-[11px] text-red-600 mt-1">{b.error}</div>}
                </div>

                <div className="flex flex-col gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLimitNotice(null);

                      setCanvasRootIds((prev) => {
                        const isOpen = prev.includes(b.rootNodeId);

                        // CLOSE: remove from canvas
                        if (isOpen) {
                          const next = prev.filter((x) => x !== b.rootNodeId);
                          if (activeCanvasRootId === b.rootNodeId) {
                            setActiveCanvasRootId(next[0] ?? null);
                          }
                          return next;
                        }

                        // OPEN: if slot available, add
                        if (prev.length < 4) {
                          setActiveCanvasRootId(b.rootNodeId);
                          return [...prev, b.rootNodeId];
                        }

                        // FULL: ask which one to replace
                        const pick = window.prompt(
                          "Canvas limit is 4 maps.\nType 1, 2, 3, or 4 to replace that slot with this map:",
                          "1"
                        );

                        const idx = Math.max(0, Math.min(3, Number(pick ?? "1") - 1));
                        const next = [...prev];
                        next[idx] = b.rootNodeId;
                        setActiveCanvasRootId(b.rootNodeId);
                        setLimitNotice("Canvas limit is 4 maps. Replaced one map on canvas.");
                        return next;
                      });

                      setTimeout(() => handleFocusImport(b.rootNodeId), 80);
                    }}
                  >
                    {canvasRootIds.includes(b.rootNodeId) ? "Close" : "Open"}
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleRedockImport(b.rootNodeId)}
                  >
                    Reset position
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!!b.linking}
                    onClick={() => {
                      // ✅ Find connections should NOT be blocked by "extra maps" limit (that limit is unrelated).
                      setError(null);
                      setLimitNotice(null);

                      // ✅ Ensure this imported map is on the canvas, otherwise edges may be hidden
                      setCanvasRootIds((prev) => {
                        if (prev.includes(b.rootNodeId)) return prev;

                        // open if there is room
                        if (prev.length < 4) {
                          setActiveCanvasRootId(b.rootNodeId);
                          return [...prev, b.rootNodeId];
                        }

                        // canvas full -> replace a slot (same behavior as your Open button)
                        const pick = window.prompt(
                          "Canvas limit is 4 maps.\nType 1, 2, 3, or 4 to replace that slot with this map:",
                          "1"
                        );
                        const idx = Math.max(0, Math.min(3, Number(pick ?? "1") - 1));
                        const next = [...prev];
                        next[idx] = b.rootNodeId;
                        setActiveCanvasRootId(b.rootNodeId);
                        return next;
                      });

                      // Find connections without changing viewport
                      handleFindImportConnections(b.rootNodeId);
                    }}
                  >
                    {b.linking ? "Linking…" : "Find connections"}
                  </Button>
                </div>

              </div>
            </div>
          ))}

          <div className="mt-3 border-t border-slate-200 pt-3">
            <div className="text-sm font-semibold text-slate-800">All maps</div>
            <div className="text-xs text-slate-500">
              Created + Imported. Only 4 can be shown on canvas.
            </div>

            <div className="mt-2 space-y-2">
              {allMaps.map((m) => (
                <div key={m.rootId} className="rounded-lg border border-slate-200 bg-white p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-800 truncate">{m.title}</div>
                      <div className="text-[11px] text-slate-500">
                        {m.origin} · root: {m.rootId.slice(0, 8)}…
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2"
                        onClick={() => handleFocusImport(m.rootId)}
                      >
                        Focus
                      </Button>

                      {m.onCanvas ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-8 px-2"
                          onClick={() => {
                            setCanvasRootIds((prev) => prev.filter((id) => id !== m.rootId));
                          }}
                        >
                          Close
                        </Button>
                      ) : (
                        <Button
                          variant="default"
                          size="sm"
                          className="h-8 px-2"
                          onClick={() => {
                            setCanvasRootIds((prev) => {
                              // OPEN if slot available
                              if (prev.length < 4) {
                                setActiveCanvasRootId(m.rootId);
                                return [...prev, m.rootId];
                              }

                              // FULL: ask which one to replace
                              const pick = window.prompt(
                                "Canvas limit is 4 maps.\nType 1, 2, 3, or 4 to replace that slot with this map:",
                                "1"
                              );
                              const idx = Math.max(0, Math.min(3, Number(pick ?? "1") - 1));
                              const next = [...prev];
                              next[idx] = m.rootId;
                              setActiveCanvasRootId(m.rootId);
                              return next;
                            });
                          }}
                        >
                          Open
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    )}

      {/* Chat with this mind map */}
      {showChatPanel && (
        <div
          className="absolute left-5 bottom-5 z-40 w-[380px] pointer-events-auto"
          onWheelCapture={(e) => e.stopPropagation()}
          onMouseDownCapture={(e) => e.stopPropagation()}
          onTouchMoveCapture={(e) => e.stopPropagation()}
        >
          <Card className="shadow-lg border-slate-200">
            <CardHeader className="py-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">
                Ask AI about this mind map
              </CardTitle>
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-slate-600"
                onClick={() => setShowChatPanel(false)}
              >
                ✕
              </button>
            </CardHeader>
            <CardContent className="pt-0 flex flex-col gap-3 overflow-hidden">
              <form onSubmit={handleAskChat} className="flex flex-col gap-2">
                <Textarea
                  value={chatQuestion}
                  onChange={(e) => setChatQuestion(e.target.value)}
                  placeholder="Example: Summarize the main ideas, or explain how Node 2 relates to Node 3…"
                  className="resize-none h-24 text-sm"
                />
                <Button
                  type="submit"
                  size="sm"
                  className="self-end"
                  disabled={chatLoading || !chatQuestion.trim()}
                >
                  {chatLoading ? "Thinking…" : "Ask AI"}
                </Button>
              </form>

              {chatError && (
                <p className="text-xs text-red-500">{chatError}</p>
              )}

              {chatMessages.length > 0 && (
                <ScrollArea
                  className="h-40 rounded-md bg-slate-50 px-3 py-2 text-sm overflow-y-auto"
                  ref={streamRef}
                >
                  <div className="flex flex-col space-y-3 overflow-y-auto max-h-[420px] pr-2">
                    {chatMessages.map((m) => (
                      <div
                        key={m.id}
                        className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-2xl px-3 py-2 shadow-sm whitespace-pre-wrap ${
                            m.role === "user"
                            ? "bg-slate-900 text-white"
                            : "bg-white text-slate-900"
                          }`}
                        >
                          {m.text}
                          {m.role === "assistant" && chatLoading && m.id === activeAssistantId && (
                            <span className="animate-pulse ml-1 opacity-70">▍</span>
                          )}

                          {/* Sources for THIS assistant message */}
                          {m.role === "assistant" && !chatLoading && (m.sources?.length ?? 0) > 0 && (
                            <div className="mt-2 pt-2 border-t border-slate-200 text-xs text-slate-500">
                              <span className="font-medium">Sources:</span>{" "}
                              <span className="inline-flex flex-wrap gap-x-2 gap-y-1">
                                {m.sources!.map((src) => (
                                  <button
                                    key={src.id}
                                    type="button"
                                    onClick={() => handleSourceClick(src.id)}
                                    className="text-blue-600 hover:underline"
                                    title={src.id}
                                  >
                                    {src.label}
                                  </button>
                                ))}
                              </span>
                            </div>
                          )}
                      
                          {/* Evidence by sentence */}
                          {m.role === "assistant" && m.id === activeAssistantId && evidenceBySentence.length > 0 && (
                            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                              <div className="mb-2">
                                <div className="text-sm font-semibold text-slate-800">
                                  Evidence by sentence
                                </div>
                                  <div className="text-xs text-slate-500">
                                    Why the AI said this
                                  </div>
                              </div>

                              <div className="space-y-2">
                                {evidenceBySentence.map((s: SentenceEvidenceDto) => {
                                  const isOpen = expandedEvidence[s.sentenceIndex] ?? false;

                                  // ✅ Always read evidence from either `evidence` or `Evidence`
                                  const spansRaw = ((s as any).evidence ?? (s as any).Evidence ?? []) as any[];

                                  // ✅ Normalize nodeId casing + type
                                  const spans = spansRaw.map((e) => ({
                                    ...e,
                                    nodeId: String(e?.nodeId ?? e?.NodeId ?? ""),
                                    textSpan: e?.textSpan ?? e?.TextSpan ?? "",
                                    score: e?.score ?? e?.Score ?? 0,
                                  }));

                                  const sentenceNodeIds = Array.from(
                                    new Set(
                                      spans
                                        .map((e) => e.nodeId)
                                        .filter((id) => id && id !== "undefined" && id !== "null")
                                      )
                                    );

                                  return (
                                    <div
                                      key={s.sentenceIndex}
                                      className="rounded-md border border-slate-200 bg-white"
                                    >
                                      {/* header */}
                                      <button
                                        type="button"
                                        className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left"
                                        onMouseEnter={() => setPreviewHighlightNodeIds(sentenceNodeIds)}
                                        onMouseLeave={() => setPreviewHighlightNodeIds([])}
                                        onClick={() => {
                                          toggleEvidence(s.sentenceIndex);

                                          setLockedHighlightNodeIds(sentenceNodeIds);
                                          setActiveSentenceIndex(s.sentenceIndex);
                                          blinkNodes(sentenceNodeIds);

                                          setEvidencePanel({
                                            open: true,
                                            sentenceIndex: s.sentenceIndex,
                                            sentence: s.sentence,
                                            // ✅ use normalized spans
                                            items: spans.filter((x) => !!x.nodeId),
                                          });
                                        }}
                                      >
                                        <div className="text-sm text-slate-800">
                                          <span className="mr-2 font-semibold">{s.sentenceIndex + 1}.</span>
                                          {s.sentence}
                                        </div>
                                      <div className="text-slate-400">{isOpen ? "▾" : "▸"}</div>
                                    </button>

                                    {/* ✅ highlight link always uses the SAME ids */}
                                    <div className="mt-2 px-3">
                                      <button
                                        type="button"
                                        className="text-xs text-blue-600 hover:underline cursor-pointer"
                                        onClick={(e) => {
                                          e.stopPropagation();

                                          if (sentenceNodeIds.length === 0) {
                                            alert("No nodes linked to this sentence.");
                                            return;
                                          }

                                          setLockedHighlightNodeIds(sentenceNodeIds);
                                          setActiveSentenceIndex(s.sentenceIndex);
                                          blinkNodes(sentenceNodeIds);
                                        }}
                                      >
                                        Highlight nodes for this sentence
                                      </button>
                                    </div>

                                    {/* body */}
                                    {isOpen && (
                                      <div className="px-3 pb-3">
                                        <div className="flex flex-wrap items-center gap-2">
                                          {(() => {
                                            const uniq = Array.from(
                                              new Map(
                                                spans
                                                  .filter((e) => !!e.nodeId && !!String(e.textSpan).trim())
                                                  .map((e) => [
                                                    `${e.nodeId}::${String(e.textSpan).trim()}`,
                                                    e,
                                                  ])
                                              ).values()
                                            )
                                              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                                              .slice(0, 6);

                                            return uniq.map((e, j) => (
                                              <button
                                                key={`${s.sentenceIndex}-${e.nodeId}-${j}`}
                                                type="button"
                                                onClick={() => handleSourceClick(e.nodeId)}
                                                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-blue-600 hover:bg-slate-50 hover:underline"
                                                title={`score: ${(e.score ?? 0).toFixed(2)}`}
                                              >
                                                {e.textSpan}
                                              </button>
                                            ));
                                          })()}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}

            </CardContent>
          </Card>
        </div>
      )}

      {contextMenu.visible && contextMenu.nodeId && (
        <div
          className="mm-context-menu"
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 50,
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            boxShadow: "0 10px 20px rgba(15,23,42,0.12)",
            padding: 8,
            minWidth: 170,
            fontSize: 12,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleAddChildNode(contextMenu.nodeId!)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "6px 10px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
            }}
          >
            ➕ Add child node
          </button>
          <button
            onClick={() => handleRenameNodeFromMenu(contextMenu.nodeId!)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "6px 10px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
            }}
          >
            ✏️ Rename node
          </button>
        </div>
      )}
    </div>
  );
}

export default function MindMapEditorPage() {
  return (
    <TooltipProvider delayDuration={150}>
      <ReactFlowProvider>
        <MindMapEditorInner />
      </ReactFlowProvider>
    </TooltipProvider>
  );
}