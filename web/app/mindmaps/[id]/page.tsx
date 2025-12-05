"use client";

import React, {
  useCallback,
  useEffect,
  useState,
} from "react";
import { useParams } from "next/navigation";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodePositionChange,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import "./edges.css";
import "./mindmap-editor.css";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5261";


const EDGE_STYLE = {
  stroke: "#4b5563", // Tailwind Gray-600
  strokeWidth: 2.4,
};

type MindMapNodeDto = {
  id: string;
  mindMapId: string;
  label?: string; // kept for compatibility
  text?: string; // used by embeddings backend
  positionX: number;
  positionY: number;
  parentId?: string | null;
};

type NodeData = {
  label: string;
};

type GraphSnapshot = {
  nodes: Node<NodeData>[];
  edges: Edge[];
};

type NodeSearchResult = {
  id: string;
  label: string;
  positionX: number;
  positionY: number;
  parentId?: string | null;
  score: number;
};

const nodeWidth = 200;
const nodeHeight = 80;

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: "TB" | "LR" = "TB"
) {
  const isHorizontal = direction === "LR";
  dagreGraph.setGraph({ rankdir: direction });

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

// Helper: deep-ish clone nodes / edges so history isn't mutated by React Flow
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
    data: e.data ? { ...e.data } : e.data,
  }));
}

export default function MindMapEditor() {
  const params = useParams();
  const mindMapId = params.id as string;

  const [nodes, setNodes] = useState<Node<NodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [rfInstance, setRfInstance] = useState<any | null>(null);

  // history for Undo/Redo
  const [history, setHistory] = useState<GraphSnapshot[]>([]);
  const [future, setFuture] = useState<GraphSnapshot[]>([]);

  const canUndo = history.length > 0;
  const canRedo = future.length > 0;

  // right-click context menu state
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

  // semantic search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<NodeSearchResult[] | null>(
    null
  // related nodes panel state
  );
  const [relatedNodes, setRelatedNodes] = useState<NodeSearchResult[] | null>(null);

  // --- helper: snapshot current graph for Undo (deep clone) -----------------
  const recordSnapshot = useCallback(() => {
    setHistory((prev) => [
      ...prev,
      {
        nodes: cloneNodes(nodes),
        edges: cloneEdges(edges),
      },
    ]);
    setFuture([]); // new action clears redo stack
  }, [nodes, edges]);

  // --- helper: find parent of a node from edges -----------------------------
  const getParentId = useCallback(
    (childId: string): string | null => {
      const parentEdge = edges.find((e) => e.target === childId);
      return parentEdge?.source ?? null;
    },
    [edges]
  );

  // --- load nodes & edges from API -----------------------------------------
  const fetchNodes = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const res = await fetch(`${API_BASE}/api/MindMapNodes/${mindMapId}`);
      if (!res.ok) {
        throw new Error(`Failed to load nodes (${res.status})`);
      }

      const data: MindMapNodeDto[] = await res.json();

      const rfNodes: Node<NodeData>[] = data.map((n) => ({
        id: n.id,
        position: { x: n.positionX, y: n.positionY },
        data: { label: n.label ?? n.text ?? "New Node" },
        style: {
          padding: 16,
          borderRadius: 9999,
          border: "1px solid #e5e7eb",
          background: "#ffffff",
          boxShadow: "0 18px 45px rgba(15,23,42,0.18)",
          fontSize: 16,
          minWidth: 180,
        },
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
      setEdges(rfEdges);
      setHistory([]); // fresh load: clear history/future
      setFuture([]);
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to load nodes");
    } finally {
      setLoading(false);
    }
  }, [mindMapId]);

  useEffect(() => {
    fetchNodes();
  }, [fetchNodes]);

  // --- API helpers ----------------------------------------------------------
  const savePosition = useCallback(
    async (nodeId: string, x: number, y: number) => {
      try {
        await fetch(`${API_BASE}/api/MindMapNodes/${nodeId}/position`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positionX: x, positionY: y }),
        });
      } catch (err) {
        console.error("Failed to save position", err);
      }
    },
    []
  );

  const saveParent = useCallback(
    async (childId: string, parentId: string | null) => {
      try {
        await fetch(`${API_BASE}/api/MindMapNodes/${childId}/parent`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parentId }),
        });
      } catch (err) {
        console.error("Failed to save parent", err);
      }
    },
    []
  );

  const saveLabel = useCallback(
    async (nodeId: string, newLabel: string, x: number, y: number) => {
      try {
        const body: MindMapNodeDto = {
          id: nodeId,
          mindMapId,
          label: newLabel,
          text: newLabel, // send text for embeddings
          positionX: x,
          positionY: y,
          parentId: getParentId(nodeId),
        };

        const res = await fetch(`${API_BASE}/api/MindMapNodes/${nodeId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          throw new Error(`Failed to save label (${res.status})`);
        }
      } catch (err) {
        console.error("Failed to save label", err);
      }
    },
    [mindMapId, getParentId]
  );

  // --- semantic search handler ---------------------------------------------
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

        const url = `${API_BASE}/api/MindMapNodes/search?mindMapId=${mindMapId}&query=${encodeURIComponent(
          query
        )}&topK=5`;

        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Search failed (${res.status})`);
        }

        const data: NodeSearchResult[] = await res.json();
        setSearchResults(data);

        const ids = data.map((r) => r.id);
        setSelectedNodeIds(ids);

        if (rfInstance && data.length > 0) {
          const best = data[0];
          const x = best.positionX + nodeWidth / 2;
          const y = best.positionY + nodeHeight / 2;

          rfInstance.setCenter(x, y, {
            zoom: 1.2,
            duration: 200,
          });
        }
      } catch (err: any) {
        console.error(err);
        setError(err.message ?? "Search failed");
      } finally {
        setSearching(false);
      }
    },
    [searchQuery, mindMapId, rfInstance]
  );

  // --- React Flow handlers --------------------------------------------------
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (changes.length === 0) return;

      recordSnapshot();

      setNodes((nds) => {
        const next = applyNodeChanges(changes, nds);

        const positionChanges = changes.filter(
          (c): c is NodePositionChange => c.type === "position"
        );

        positionChanges.forEach((c) => {
          const node = next.find((n) => n.id === c.id);
          if (node && c.position) {
            savePosition(node.id, c.position.x, c.position.y);
          }
        });

        return next;
      });
    },
    [recordSnapshot, savePosition]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (changes.length === 0) return;

      recordSnapshot();
      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [recordSnapshot]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      recordSnapshot();

      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: "smoothstep",
            animated: false,
            style: EDGE_STYLE,
          },
          eds
        )
      );

      if (connection.target) {
        saveParent(connection.target, connection.source ?? null);
      }
    },
    [recordSnapshot, saveParent]
  );

  const handleNodeClick = useCallback(
  async (_: any, node: Node<NodeData>) => {
    setSelectedNodeIds([node.id]);

    try {
      const url = `${API_BASE}/api/MindMapNodes/${mindMapId}/${node.id}/related`;
      const res = await fetch(url);

      if (!res.ok) throw new Error(`Related nodes failed (${res.status})`);

      const data = await res.json();
      setRelatedNodes(data);
    } catch (err) {
      console.error(err);
      setRelatedNodes(null);
    }
  },
  [mindMapId]
);

  const handleSelectionChange = useCallback((selection: any) => {
    const ids: string[] = (selection?.nodes ?? []).map((n: Node) => n.id);
    setSelectedNodeIds(ids);
  }, []);

  const handleNodeDoubleClick = useCallback(
    async (_: any, node: Node<NodeData>) => {
      const currentLabel = node.data?.label ?? "";
      const newLabel = window.prompt("Edit node label", currentLabel);

      if (
        newLabel == null ||
        newLabel.trim() === "" ||
        newLabel === currentLabel
      ) {
        return;
      }

      const trimmed = newLabel.trim();

      recordSnapshot();

      setNodes((prev) =>
        prev.map((n) =>
          n.id === node.id ? { ...n, data: { ...n.data, label: trimmed } } : n
        )
      );

      await saveLabel(node.id, trimmed, node.position.x, node.position.y);
    },
    [recordSnapshot, saveLabel]
  );

  const handleAddNode = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      recordSnapshot();

      const defaultLabel = "New Node";

      const body = {
        mindMapId,
        label: defaultLabel,
        text: defaultLabel, // send text for embeddings
        positionX: 200,
        positionY: 200,
        parentId: null,
      };

      const res = await fetch(`${API_BASE}/api/MindMapNodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`Failed to create node (${res.status})`);
      }

      const created: MindMapNodeDto = await res.json();

      setNodes((prev) => [
        ...prev,
        {
          id: created.id,
          position: { x: created.positionX, y: created.positionY },
          data: {
            label: created.label ?? created.text ?? defaultLabel,
          },
          style: {
            padding: 16,
            borderRadius: 9999,
            border: "1px solid #e5e7eb",
            background: "#ffffff",
            boxShadow: "0 18px 45px rgba(15,23,42,0.18)",
            fontSize: 16,
            minWidth: 180,
          },
        },
      ]);
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to create node");
    } finally {
      setLoading(false);
    }
  }, [mindMapId, recordSnapshot]);

  const handleDeleteSelected = useCallback(async () => {
    if (selectedNodeIds.length === 0) return;

    try {
      setLoading(true);
      setError(null);

      recordSnapshot();

      for (const id of selectedNodeIds) {
        const res = await fetch(`${API_BASE}/api/MindMapNodes/${id}`, {
          method: "DELETE",
        });

        if (!res.ok) {
          throw new Error(`Failed to delete node (${res.status})`);
        }
      }

      setNodes((nds) => nds.filter((n) => !selectedNodeIds.includes(n.id)));
      setEdges((eds) =>
        eds.filter(
          (e) =>
            !selectedNodeIds.includes(e.source as string) &&
            !selectedNodeIds.includes(e.target as string)
        )
      );

      setSelectedNodeIds([]);
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to delete node");
    } finally {
      setLoading(false);
    }
  }, [selectedNodeIds, recordSnapshot]);

  // --- right-click context menu actions ------------------------------------
  const handleNodeContextMenu = useCallback(
    (event: any, node: Node<NodeData>) => {
      event.preventDefault();
      event.stopPropagation();

      setSelectedNodeIds([node.id]);

      setContextMenu({
        visible: true,
        x: event.clientX,
        y: event.clientY,
        nodeId: node.id,
      });
    },
    []
  );

  const handleAddChildNode = useCallback(
    async (parentId: string) => {
      hideContextMenu();

      try {
        setLoading(true);
        setError(null);

        recordSnapshot();

        const parent = nodes.find((n) => n.id === parentId);
        const baseX = parent ? parent.position.x : 200;
        const baseY = parent ? parent.position.y : 200;

        const defaultLabel = "New Node";

        const body = {
          mindMapId,
          label: defaultLabel,
          text: defaultLabel, // send text for embeddings
          positionX: baseX + nodeWidth + 20,
          positionY: baseY,
          parentId,
        };

        const res = await fetch(`${API_BASE}/api/MindMapNodes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          throw new Error(`Failed to create child node (${res.status})`);
        }

        const created: MindMapNodeDto = await res.json();

        setNodes((prev) => [
          ...prev,
          {
            id: created.id,
            position: { x: created.positionX, y: created.positionY },
            data: {
              label: created.label ?? created.text ?? defaultLabel,
            },
            style: {
              padding: 16,
              borderRadius: 9999,
              border: "1px solid #e5e7eb",
              background: "#ffffff",
              boxShadow: "0 18px 45px rgba(15,23,42,0.18)",
              fontSize: 16,
              minWidth: 180,
            },
          },
        ]);

        setEdges((prev) => [
          ...prev,
          {
            id: `${parentId}-${created.id}`,
            source: parentId,
            target: created.id,
            type: "smoothstep",
            animated: false,
            style: EDGE_STYLE,
          },
        ]);
      } catch (err: any) {
        console.error(err);
        setError(err.message ?? "Failed to create child node");
      } finally {
        setLoading(false);
      }
    },
    [hideContextMenu, recordSnapshot, nodes, mindMapId]
  );

  const handleRenameNodeFromMenu = useCallback(
    async (nodeId: string) => {
      hideContextMenu();

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      const currentLabel = node.data?.label ?? "";
      const newLabel = window.prompt("Edit node label", currentLabel);
      if (
        newLabel == null ||
        newLabel.trim() === "" ||
        newLabel === currentLabel
      ) {
        return;
      }

      const trimmed = newLabel.trim();

      recordSnapshot();

      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, label: trimmed } } : n
        )
      );

      await saveLabel(nodeId, trimmed, node.position.x, node.position.y);
    },
    [hideContextMenu, nodes, recordSnapshot, saveLabel]
  );

  const handleDeleteNodeFromMenu = useCallback(
    async (nodeId: string) => {
      hideContextMenu();

      try {
        setLoading(true);
        setError(null);

        recordSnapshot();

        const res = await fetch(`${API_BASE}/api/MindMapNodes/${nodeId}`, {
          method: "DELETE",
        });

        if (!res.ok) {
          throw new Error(`Failed to delete node (${res.status})`);
        }

        setNodes((nds) => nds.filter((n) => n.id !== nodeId));
        setEdges((eds) =>
          eds.filter((e) => e.source !== nodeId && e.target !== nodeId)
        );
        setSelectedNodeIds((ids) => ids.filter((id) => id !== nodeId));
      } catch (err: any) {
        console.error(err);
        setError(err.message ?? "Failed to delete node");
      } finally {
        setLoading(false);
      }
    },
    [hideContextMenu, recordSnapshot]
  );

  const handleCenterOnNode = useCallback(
    (nodeId: string) => {
      hideContextMenu();

      if (!rfInstance) return;

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      const x = node.position.x + nodeWidth / 2;
      const y = node.position.y + nodeHeight / 2;

      rfInstance.setCenter(x, y, {
        zoom: 1.2,
        duration: 200,
      });
    },
    [hideContextMenu, rfInstance, nodes]
  );

  // --- Undo / Redo ----------------------------------------------------------
  const handleUndo = useCallback(() => {
    setHistory((hist) => {
      if (hist.length === 0) return hist;

      const previous = hist[hist.length - 1];
      const remaining = hist.slice(0, -1);

      // push current into future (cloned)
      setFuture((f) => [
        {
          nodes: cloneNodes(nodes),
          edges: cloneEdges(edges),
        },
        ...f,
      ]);

      // restore previous
      setNodes(cloneNodes(previous.nodes));
      setEdges(cloneEdges(previous.edges));

      return remaining;
    });
  }, [nodes, edges]);

  const handleRedo = useCallback(() => {
    setFuture((fut) => {
      if (fut.length === 0) return fut;

      const [next, ...rest] = fut;

      // current -> history
      setHistory((hist) => [
        ...hist,
        {
          nodes: cloneNodes(nodes),
          edges: cloneEdges(edges),
        },
      ]);

      // apply next
      setNodes(cloneNodes(next.nodes));
      setEdges(cloneEdges(next.edges));

      return rest;
    });
  }, [nodes, edges]);

  // --- keyboard shortcuts (safer) ------------------------------------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key;

      // IMPORTANT: we only use Delete, not Backspace
      if (key === "Delete" && selectedNodeIds.length > 0) {
        e.preventDefault();
        handleDeleteSelected();
        return;
      }

      // Ctrl + A -> select all nodes
      if (e.ctrlKey && key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedNodeIds(nodes.map((n) => n.id));
        return;
      }

      // Ctrl + Z -> Undo
      if (e.ctrlKey && key.toLowerCase() === "z") {
        e.preventDefault();
        if (canUndo) handleUndo();
        return;
      }

      // Ctrl + Y -> Redo
      if (e.ctrlKey && key.toLowerCase() === "y") {
        e.preventDefault();
        if (canRedo) handleRedo();
        return;
      }

      // Escape -> close context menu or clear selection
      if (key === "Escape") {
        if (contextMenu.visible) {
          e.preventDefault();
          hideContextMenu();
          return;
        }

        if (selectedNodeIds.length > 0) {
          e.preventDefault();
          setSelectedNodeIds([]);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedNodeIds,
    nodes,
    canUndo,
    canRedo,
    handleDeleteSelected,
    handleUndo,
    handleRedo,
    contextMenu.visible,
    hideContextMenu,
  ]);

  // close context menu on click / scroll
  useEffect(() => {
    const handleClickOrScroll = () => {
      hideContextMenu();
    };

    window.addEventListener("click", handleClickOrScroll);
    window.addEventListener("scroll", handleClickOrScroll);

    return () => {
      window.removeEventListener("click", handleClickOrScroll);
      window.removeEventListener("scroll", handleClickOrScroll);
    };
  }, [hideContextMenu]);

  // --- Day 6: auto-layout & fit view ---------------------------------------
  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0) return;
    recordSnapshot();

    setNodes((nds) => {
      const { nodes: layouted } = getLayoutedElements(
        nds as Node[],
        edges,
        "TB"
      );
      return [...(layouted as Node<NodeData>[])];
    });
  }, [edges, nodes.length, recordSnapshot]);

  const handleFitView = useCallback(() => {
    if (rfInstance) {
      rfInstance.fitView({ padding: 0.2 });
    }
  }, [rfInstance]);

  // --- render ---------------------------------------------------------------
  return (
    <div className="mm-root">
      <div className="mm-toolbar">
        <div className="mm-toolbar-title">
          Mind Map Editor&nbsp;
          <span>(ID: {mindMapId})</span>
        </div>

        <div className="mm-toolbar-actions">
          {/* Undo / Redo */}
          <button
            onClick={handleUndo}
            disabled={!canUndo}
            className="mm-btn mm-btn-ghost"
          >
            ⟲ Undo
          </button>
          <button
            onClick={handleRedo}
            disabled={!canRedo}
            className="mm-btn mm-btn-ghost"
          >
            ⟳ Redo
          </button>

          {/* Existing actions */}
          <button
            onClick={handleAddNode}
            disabled={loading}
            className="mm-btn mm-btn-primary"
          >
            + Add node
          </button>

          <button
            onClick={handleDeleteSelected}
            disabled={selectedNodeIds.length === 0 || loading}
            className="mm-btn mm-btn-danger"
          >
            Delete selected
          </button>

          <button
            onClick={handleAutoLayout}
            disabled={nodes.length === 0}
            className="mm-btn mm-btn-ghost"
          >
            Auto-layout
          </button>

          <button
            onClick={handleFitView}
            disabled={!rfInstance}
            className="mm-btn mm-btn-ghost"
          >
            Fit view
          </button>

          {/* Semantic search */}
          <form
            onSubmit={handleSearch}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginLeft: 16,
            }}
          >
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Semantic search…"
              style={{
                padding: "6px 10px",
                borderRadius: 9999,
                border: "1px solid #e5e7eb",
                fontSize: 13,
                minWidth: 180,
              }}
            />
            <button
              type="submit"
              disabled={searching || !searchQuery.trim()}
              className="mm-btn mm-btn-ghost"
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </form>
        </div>

        <div className="mm-toolbar-status">
          {selectedNodeIds.length > 0 && (
            <span>{selectedNodeIds.length} selected</span>
          )}
          {searchResults && searchResults.length > 0 && (
            <span style={{ marginLeft: 8 }}>
              Top match: {searchResults[0].label} (
              {searchResults[0].score.toFixed(2)})
            </span>
          )}
          {loading && <span>Loading…</span>}
          {error && <span style={{ color: "red" }}>Error: {error}</span>}
        </div>
      </div>

      <div className="mm-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onSelectionChange={handleSelectionChange}
          onNodeContextMenu={handleNodeContextMenu}
          onInit={(instance) => setRfInstance(instance)}
          /* interaction polish */
          panOnScroll
          panOnScrollSpeed={0.8}
          panOnDrag={[1, 2]} // pan with middle + right mouse buttons (pane)
          selectionOnDrag
          multiSelectionKeyCode="Shift"
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick={false}
          minZoom={0.5}
          maxZoom={1.8}
          fitView
        >
          <MiniMap />
          <Controls />
          <Background gap={16} size={1} />
        </ReactFlow>
      </div>

      {/* Related Ideas Panel */}
{relatedNodes && (
  <div
    style={{
      position: "absolute",
      right: 20,
      top: 80,
      width: 260,
      background: "#ffffff",
      border: "1px solid #e5e7eb",
      borderRadius: 12,
      padding: "12px 14px",
      boxShadow: "0 12px 32px rgba(0,0,0,0.08)",
      zIndex: 40,
      maxHeight: "70vh",
      overflowY: "auto",
    }}
  >
    <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
      Related Ideas
    </h3>

    {relatedNodes.length === 0 && (
      <p style={{ fontSize: 13, color: "#6b7280" }}>No related ideas found.</p>
    )}

    {relatedNodes.length > 0 && (
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {relatedNodes.map((r) => (
          <li
            key={r.id}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              marginBottom: 8,
              cursor: "pointer",
              background: "#f9fafb",
            }}
            onClick={() => handleCenterOnNode(r.id)}
          >
            <div style={{ fontSize: 14, fontWeight: 500 }}>{r.label}</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              Node ID: {r.id.slice(0, 6)}…
            </div>
          </li>
        ))}
      </ul>
    )}
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
            ✏️ Rename
          </button>
          <button
            onClick={() => handleDeleteNodeFromMenu(contextMenu.nodeId!)}
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
            🗑 Delete
          </button>
          <button
            onClick={() => handleCenterOnNode(contextMenu.nodeId!)}
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
            🎯 Center on this
          </button>
        </div>
      )}
    </div>
  );
}
