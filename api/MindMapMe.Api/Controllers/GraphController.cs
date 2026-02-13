using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using MindMapMe.Application.AI;            // for EmbeddingSimilarity
using MindMapMe.Infrastructure.Persistence;

namespace MindMapMe.Api.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class GraphController : ControllerBase
    {
        private readonly AppDbContext _db;

        public GraphController(AppDbContext db)
        {
            _db = db;
        }

        /// <summary>
        /// Returns an AI-suggested relationship graph for a mind map.
        /// It does NOT change the database, just computes edges from embeddings.
        /// </summary>
        /// GET /api/graph/mindmaps/{mindMapId}?minScore=0.4&maxEdgesPerNode=2
        [HttpGet("mindmaps/{mindMapId:guid}")]
        public async Task<ActionResult<GraphResponseDto>> GetMindMapGraph(
            Guid mindMapId,
            [FromQuery] double minScore = 0.4,
            [FromQuery] int maxEdgesPerNode = 2,
            CancellationToken cancellationToken = default)
        {
            if (mindMapId == Guid.Empty)
            {
                return BadRequest("mindMapId is required.");
            }

            if (minScore <= 0) minScore = 0.1;
            if (minScore > 1) minScore = 1.0;
            if (maxEdgesPerNode <= 0) maxEdgesPerNode = 2;

            // 1) Load nodes that have embeddings
            var nodes = await _db.MindMapNodes
                .Where(n =>
                    n.MindMapId == mindMapId &&
                    n.Embedding != null &&
                    n.Embedding.Any())
                .ToListAsync(cancellationToken);

            var response = new GraphResponseDto
            {
                Nodes = nodes.Select(n => new GraphNodeDto
                {
                    Id = n.Id,
                    Label = n.Label ?? string.Empty,
                    PositionX = n.PositionX,
                    PositionY = n.PositionY
                }).ToList()
            };

            // Not enough nodes for relationships
            if (nodes.Count < 2)
            {
                return Ok(response);
            }

            // 2) Compute ALL pairwise similarities (no threshold yet)
            var allCandidates = new List<GraphEdgeDto>();

            for (int i = 0; i < nodes.Count; i++)
            {
                var a = nodes[i];

                if (a.Embedding == null || !a.Embedding.Any())
                    continue;

                for (int j = i + 1; j < nodes.Count; j++)
                {
                    var b = nodes[j];

                    if (b.Embedding == null || !b.Embedding.Any())
                        continue;

                    var score = EmbeddingSimilarity.CosineSimilarity(
                        a.Embedding,
                        b.Embedding);

                    allCandidates.Add(new GraphEdgeDto
                    {
                        SourceId = a.Id,
                        TargetId = b.Id,
                        Score = score
                    });
                }
            }

            if (!allCandidates.Any())
            {
                // No usable embeddings at all
                return Ok(response);
            }

            // 3) Prefer high-score edges; if none are above minScore,
            //    fall back to "best available" edges.
            var filtered = allCandidates
                .Where(e => e.Score >= minScore)
                .ToList();

            if (!filtered.Any())
            {
                // Fallback: use all candidates (still sorted by score)
                filtered = allCandidates.ToList();
            }

            filtered = filtered
                .OrderByDescending(e => e.Score)
                .ToList();

            var usedCounts = new Dictionary<Guid, int>();

            foreach (var edge in filtered)
            {
                usedCounts.TryGetValue(edge.SourceId, out var c1);
                usedCounts.TryGetValue(edge.TargetId, out var c2);

                if (c1 >= maxEdgesPerNode || c2 >= maxEdgesPerNode)
                {
                    continue;
                }

                response.Edges.Add(edge);

                usedCounts[edge.SourceId] = c1 + 1;
                usedCounts[edge.TargetId] = c2 + 1;
            }

            return Ok(response);
        }
    }

    // DTOs for the graph response
    public class GraphResponseDto
    {
        public List<GraphNodeDto> Nodes { get; set; } = new();
        public List<GraphEdgeDto> Edges { get; set; } = new();
    }

    public class GraphNodeDto
    {
        public Guid Id { get; set; }
        public string Label { get; set; } = string.Empty;
        public double PositionX { get; set; }
        public double PositionY { get; set; }
    }

    public class GraphEdgeDto
    {
        public Guid SourceId { get; set; }
        public Guid TargetId { get; set; }
        public double Score { get; set; }
    }
}
