using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using MindMapMe.Application.Search;
using MindMapMe.Domain.Entities;
using MindMapMe.Infrastructure.Persistence;

namespace MindMapMe.Infrastructure.Search
{
    public class SemanticSearchService : ISemanticSearchService
    {
        private readonly AppDbContext _db;

        public SemanticSearchService(AppDbContext db)
        {
            _db = db;
        }

        public async Task<List<(MindMapNode node, double score)>> SearchNodesAsync(
            Guid mindMapId,
            string query,
            int topK)
        {
            if (topK <= 0)
            {
                return new List<(MindMapNode node, double score)>();
            }

            query = query?.Trim() ?? string.Empty;

            // Base query: all nodes in this mind map
            IQueryable<MindMapNode> q = _db.MindMapNodes
                .Where(n => n.MindMapId == mindMapId);

            // Simple text filter on Label ONLY (we're not relying on Content / CreatedAt)
            if (!string.IsNullOrEmpty(query))
            {
                var pattern = $"%{query}%";

                q = q.Where(n =>
                    EF.Functions.ILike(n.Label!, pattern));
            }

            // Just take topK and order by label to have deterministic results
            var nodes = await q
                .OrderBy(n => n.Label)
                .Take(topK)
                .ToListAsync();

            // Produce a simple relevance score (1.0, 0.9, 0.8, ...)
            int count = Math.Max(nodes.Count, 1);

            var results = nodes
                .Select((n, index) =>
                    (node: n, score: 1.0 - (double)index / count))
                .ToList();

            return results;
        }
    }
}
