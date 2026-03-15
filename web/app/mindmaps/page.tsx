"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5261";

function authHeaders(extra: Record<string, string> = {}) {
  let key = localStorage.getItem("mindmap_owner_key");

  if (!key) {
    key = crypto.randomUUID();
    localStorage.setItem("mindmap_owner_key", key);
  }

  return {
    "X-Owner-Key": key,
    ...extra,
  };
}

type MindMapDto = {
  id: string;
  title: string;
  description?: string | null;
  createdAt: string;
};

export default function MindMapsPage() {
  const router = useRouter();

  const [mindMaps, setMindMaps] = useState<MindMapDto[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");

  // Load list
  const loadMindMaps = async () => {
    try {
      setLoading(true);
      setError(null);

      const res = await fetch(`${API_BASE}/api/mindmaps`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Failed to load mind maps (${res.status})`);

      const data: MindMapDto[] = await res.json();
      setMindMaps(data);
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to load mind maps");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMindMaps();
  }, []);

  // Create
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) return;

    try {
      setLoading(true);
      setError(null);

      const res = await fetch(`${API_BASE}/api/mindmaps`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          title,
          description,
        }),
      });

      if (!res.ok) throw new Error("Failed to create mind map");

      setTitle("");
      setDescription("");
      await loadMindMaps();
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to create mind map");
    } finally {
      setLoading(false);
    }
  };

  // Delete
  const handleDelete = async (id: string) => {
    if (!confirm("Delete this mind map?")) return;

    try {
      setLoading(true);
      setError(null);

      const res = await fetch(`${API_BASE}/api/mindmaps/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error("Failed to delete mind map");

      await loadMindMaps();
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to delete mind map");
    } finally {
      setLoading(false);
    }
  };

  // Start editing
  const startEdit = (m: MindMapDto) => {
    setEditingId(m.id);
    setEditTitle(m.title);
    setEditDescription(m.description ?? "");
  };

  // Cancel editing
  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle("");
    setEditDescription("");
  };

  // Save edit
  const saveEdit = async (id: string) => {
    try {
      setLoading(true);
      setError(null);

      const res = await fetch(`${API_BASE}/api/mindmaps/${id}`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          id,
          title: editTitle,
          description: editDescription,
        }),
      });

      if (!res.ok) throw new Error("Failed to update mind map");

      setEditingId(null);
      setEditTitle("");
      setEditDescription("");
      await loadMindMaps();
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Failed to update mind map");
    } finally {
      setLoading(false);
    }
  };

  // Open React-Flow editor
  const openEditor = (id: string) => {
    router.push(`/mindmaps/${id}`);
  };

  return (
    <div style={{ padding: "40px", maxWidth: 900, margin: "0 auto" }}>
      <h1>Mind Maps</h1>

      {error && (
        <p style={{ color: "red", marginBottom: 16 }}>
          Error: {error}
        </p>
      )}

      {/* Create form */}
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          padding: 16,
          marginBottom: 32,
        }}
      >
        <h2>Create new mind map</h2>
        <form onSubmit={handleCreate}>
          <div style={{ marginBottom: 12 }}>
            <label>
              Title
              <br />
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{ width: "100%", padding: 8 }}
              />
            </label>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label>
              Description
              <br />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ width: "100%", padding: 8, minHeight: 80 }}
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={loading || !title.trim()}
            style={{
              padding: "8px 16px",
              borderRadius: 4,
              border: "1px solid #ccc",
              cursor: "pointer",
            }}
          >
            Create
          </button>
        </form>
      </div>

      {/* List of maps */}
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          padding: 16,
        }}
      >
        <h2>Existing mind maps</h2>

        {loading && mindMaps.length === 0 && <p>Loading...</p>}

        {mindMaps.length === 0 && !loading && <p>No mind maps yet.</p>}

        {mindMaps.map((m) => (
          <div
            key={m.id}
            style={{
              borderTop: "1px solid #eee",
              padding: "12px 0",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {editingId === m.id ? (
              <>
                <div>
                  <label>
                    Title
                    <br />
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      style={{ width: "100%", padding: 6 }}
                    />
                  </label>
                </div>
                <div>
                  <label>
                    Description
                    <br />
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      style={{ width: "100%", padding: 6, minHeight: 60 }}
                    />
                  </label>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => saveEdit(m.id)}
                    disabled={loading || !editTitle.trim()}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 4,
                      border: "1px solid #ccc",
                      cursor: "pointer",
                    }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 4,
                      border: "1px solid #ccc",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <strong>{m.title}</strong>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    Created: {new Date(m.createdAt).toLocaleString()}
                  </div>
                  {m.description && (
                    <div style={{ marginTop: 4 }}>{m.description}</div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => openEditor(m.id)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 4,
                      border: "1px solid #ccc",
                      cursor: "pointer",
                    }}
                  >
                    Open editor
                  </button>
                  <button
                    onClick={() => startEdit(m)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 4,
                      border: "1px solid #ccc",
                      cursor: "pointer",
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(m.id)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 4,
                      border: "1px solid #f88",
                      background: "#fee",
                      cursor: "pointer",
                    }}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
