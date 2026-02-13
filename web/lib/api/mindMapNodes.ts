// web/lib/api/mindMapNodes.ts

// NOTE: set NEXT_PUBLIC_API_BASE_URL in .env.local, or this falls back to localhost:5261
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5261";

const API_ROOT = `${API_BASE_URL}/api/MindMapNodes`;

export interface MindMapNodeDto {
  id: string;
  mindMapId: string;
  label: string;
  positionX: number;
  positionY: number;
  parentId: string | null;
  embedding: number[]; // comes from the backend, we usually won't send this from the UI
}

export interface MindMapNodeSearchResultDto {
  id: string;
  mindMapId: string;
  label: string;
  positionX: number;
  positionY: number;
  parentId: string | null;
  score: number;
}

// ---------- basic helpers ----------

// GET /api/MindMapNodes/{mindMapId}
export async function fetchMindMapNodes(
  mindMapId: string
): Promise<MindMapNodeDto[]> {
  const res = await fetch(`${API_ROOT}/${mindMapId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Failed to load nodes (${res.status})`);
  }

  return res.json();
}

// POST /api/MindMapNodes
export async function createMindMapNode(
  node: Omit<MindMapNodeDto, "embedding">
): Promise<MindMapNodeDto> {
  const res = await fetch(API_ROOT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(node),
  });

  if (!res.ok) {
    throw new Error(`Failed to create node (${res.status})`);
  }

  return res.json();
}

// PUT /api/MindMapNodes/{id}
export async function updateMindMapNode(
  id: string,
  node: Omit<MindMapNodeDto, "id" | "embedding">
): Promise<void> {
  const res = await fetch(`${API_ROOT}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(node),
  });

  if (!res.ok) {
    throw new Error(`Failed to update node (${res.status})`);
  }
}

// ---------- semantic search helper ----------

// GET /api/MindMapNodes/search?mindMapId=...&query=...&topK=...
export async function searchMindMapNodes(
  mindMapId: string,
  query: string,
  topK: number
): Promise<MindMapNodeSearchResultDto[]> {
  const params = new URLSearchParams({
    mindMapId,
    query,
    topK: String(topK),
  });

  const res = await fetch(`${API_ROOT}/search?${params.toString()}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Failed to search nodes (${res.status})`);
  }

  return res.json();
}
