using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using MindMapMe.Domain.Entities;
using MindMapMe.Infrastructure.Persistence;
using MindMapMe.Application.AI;
using System.Linq;

namespace MindMapMe.Api.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class MindMapNodesController : ControllerBase
    {
        private readonly AppDbContext _db;
        private readonly IEmbeddingService _embeddingService;
        private readonly INodeSemanticSearchService _semanticSearch;

        public MindMapNodesController(
            AppDbContext db,
            IEmbeddingService embeddingService,
            INodeSemanticSearchService semanticSearch)
        {
            _db = db;
            _embeddingService = embeddingService;
            _semanticSearch = semanticSearch;
        }

        // GET: api/MindMapNodes/{mindMapId}
        [HttpGet("{mindMapId}")]
        public async Task<IActionResult> GetNodes(Guid mindMapId)
        {
            var nodes = await _db.MindMapNodes
                .Where(n => n.MindMapId == mindMapId)
                .ToListAsync();

            return Ok(nodes);
        }

        // POST: api/MindMapNodes
        [HttpPost]
        public async Task<IActionResult> CreateNode([FromBody] MindMapNode node)
        {
            node.Id = Guid.NewGuid();

            // 🔥 Generate embedding using the node's label
            if (!string.IsNullOrWhiteSpace(node.Label))
            {
                node.Embedding = await _embeddingService.GetEmbeddingAsync(node.Label);
            }

            _db.MindMapNodes.Add(node);
            await _db.SaveChangesAsync();

            return Ok(node);
        }

        // PUT: api/MindMapNodes/{id}/position
        [HttpPut("{id}/position")]
        public async Task<IActionResult> UpdatePosition(Guid id, [FromBody] UpdatePositionDto dto)
        {
            var node = await _db.MindMapNodes.FindAsync(id);
            if (node == null)
                return NotFound();

            node.PositionX = dto.PositionX;
            node.PositionY = dto.PositionY;

            await _db.SaveChangesAsync();
            return NoContent();
        }

        // 🔹 update only the ParentId (for connections)
        // PUT: api/MindMapNodes/{id}/parent
        [HttpPut("{id}/parent")]
        public async Task<IActionResult> UpdateParent(Guid id, [FromBody] UpdateParentDto dto)
        {
            var node = await _db.MindMapNodes.FindAsync(id);
            if (node == null)
                return NotFound();

            node.ParentId = dto.ParentId;
            await _db.SaveChangesAsync();

            return NoContent();
        }

        // PUT: api/MindMapNodes/{id}
        [HttpPut("{id}")]
        public async Task<IActionResult> UpdateNode(Guid id, [FromBody] MindMapNode node)
        {
            var existing = await _db.MindMapNodes.FindAsync(id);
            if (existing == null) return NotFound();

            // Normalize label to avoid “phantom changes” (trailing spaces etc.)
            var oldLabelNorm = (existing.Label ?? "").Trim();
            var newLabelNorm = (node.Label ?? "").Trim();

            existing.Label = string.IsNullOrWhiteSpace(newLabelNorm) ? null : newLabelNorm;
            existing.PositionX = node.PositionX;
            existing.PositionY = node.PositionY;
            existing.ParentId = node.ParentId;

            // ✅ Recompute embedding ONLY if normalized label actually changed
            if (!string.IsNullOrWhiteSpace(newLabelNorm) &&
            !string.Equals(oldLabelNorm, newLabelNorm, StringComparison.Ordinal))
            {
                try
                {
                    existing.Embedding = await _embeddingService.GetEmbeddingAsync(newLabelNorm);
                }
                catch (Exception ex)
                {
                    // Do NOT fail the node update if embeddings fail (prevents editor breaking on click/drag)
                    // Optional: log ex here if you have a logger
                    // _logger.LogWarning(ex, "Embedding update failed for node {NodeId}", id);
                }
            }

            await _db.SaveChangesAsync();
            return Ok(existing);
        }

        // 🔍 TEXT SEARCH (existing logic)
        // GET: api/MindMapNodes/search?mindMapId=...&query=...&topK=10
        [HttpGet("search")]
        public async Task<IActionResult> SearchNodes(
            [FromQuery] Guid mindMapId,
            [FromQuery] string query,
            [FromQuery] int topK = 10,
            CancellationToken ct = default)
        {
            if (string.IsNullOrWhiteSpace(query))
                return BadRequest("Query cannot be empty.");

            // 1) Get embedding for the search query
            var queryEmbedding = await _embeddingService.GetEmbeddingAsync(query, ct);
            if (queryEmbedding.Length == 0)
                return Ok(Array.Empty<NodeSearchResult>());

            // 2) Load nodes for this mind map that actually have embeddings
            var nodes = await _db.MindMapNodes
                .Where(n => n.MindMapId == mindMapId && n.Embedding != null)
                .ToListAsync(ct);

            // 3) Compute cosine similarity in memory
            var results = nodes
                .Select(n => new NodeSearchResult(
                    n.Id,
                    n.Label,
                    n.PositionX,
                    n.PositionY,
                    n.ParentId,
                    CosineSimilarity(queryEmbedding, n.Embedding!)
                ))
                .OrderByDescending(r => r.Score)
                .Take(topK)
                .ToList();

            return Ok(results);
        }

        // 🔗 RELATED NODES (Day 9 feature)
        // GET: api/MindMapNodes/{mindMapId}/{nodeId}/related
        // 🔗 RELATED NODES (Day 9 feature, with fallback)
// GET: api/MindMapNodes/{mindMapId}/{nodeId}/related
[HttpGet("{mindMapId}/{nodeId}/related")]
public async Task<IActionResult> GetRelatedNodes(
    Guid mindMapId,
    Guid nodeId,
    CancellationToken ct = default)
{
    // 1) Try true AI-based related nodes (embeddings)
    var related = await _semanticSearch.GetRelatedNodesAsync(
        mindMapId,
        nodeId,
        10,
        ct);

    List<MindMapNode> final;

    if (related != null && related.Any())
    {
        // ✅ Real AI-based relationships
        final = related.ToList();
    }
    else
    {
        // 🔁 Fallback: if embeddings are missing or AI gives nothing,
        // just return other nodes from the same mindmap.
        final = await _db.MindMapNodes
            .Where(n => n.MindMapId == mindMapId && n.Id != nodeId)
            .OrderBy(n => n.Label)   // simple, stable ordering
            .Take(10)
            .ToListAsync(ct);
    }

    const double threshold = 0.40;

    var selected = await _db.MindMapNodes
        .AsNoTracking()
        .FirstOrDefaultAsync(n => n.Id == nodeId && n.MindMapId == mindMapId, ct);

    if (selected == null || selected.Embedding == null)
    {
        return Ok(Array.Empty<object>());
    }

    var results = final
        .Where(n => n.Embedding != null)
        .Where(n => !IsGenericHub(n.Label))
        .Select(n => new
        {
            nodeId = n.Id,
            title = n.Label,
            n.PositionX,
            n.PositionY,
            n.ParentId,
            similarity = CosineSimilarity(selected.Embedding!, n.Embedding!)
        })
        .Where(x => x.similarity >= threshold)
        .OrderByDescending(x => x.similarity)
        .Take(10)
        .ToList();

    return Ok(results);

}


        // DELETE: api/MindMapNodes/{id}
        [HttpDelete("{id}")]
        public async Task<IActionResult> DeleteNode(Guid id)
        {
            var existing = await _db.MindMapNodes.FindAsync(id);
            if (existing == null) return NotFound();

            _db.MindMapNodes.Remove(existing);
            await _db.SaveChangesAsync();
            return Ok();
        }

        // DTOs
        public class UpdatePositionDto
        {
            public float PositionX { get; set; }
            public float PositionY { get; set; }
        }

        public class UpdateParentDto
        {
            public Guid? ParentId { get; set; }
        }

        public record NodeSearchResult(
            Guid Id,
            string Label,
            float PositionX,
            float PositionY,
            Guid? ParentId,
            double Score);

        private static bool IsGenericHub(string? label)
        {
            if (string.IsNullOrWhiteSpace(label)) return true;

            var s = label.Trim().ToLowerInvariant();

            return s is "overview" or "summary" or "key features" or "features"
                || s.Contains("proposed solution")
                || s.Contains("introduction")
                || s.Contains("conclusion");
        }

        private static double CosineSimilarity(float[] a, float[] b)
        {
            if (a == null || b == null || a.Length == 0 || b.Length == 0)
                return 0.0;

            var len = Math.Min(a.Length, b.Length);

            double dot = 0;
            double magA = 0;
            double magB = 0;

            for (int i = 0; i < len; i++)
            {
                var va = a[i];
                var vb = b[i];

                dot += va * vb;
                magA += va * va;
                magB += vb * vb;
            }

            if (magA == 0 || magB == 0)
                return 0.0;

            return dot / (Math.Sqrt(magA) * Math.Sqrt(magB));
        }
    }
}

// This can stay here or move into its own file if you want later
public class UpdateNodeLabelRequest
{
    public string Label { get; set; } = string.Empty;
}
