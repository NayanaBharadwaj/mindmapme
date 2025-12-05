using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MindMapMe.Application.AI;
using MindMapMe.Domain.Entities;
using MindMapMe.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace MindMapMe.Infrastructure.AI
{
    public class NodeSemanticSearchService : INodeSemanticSearchService
    {
        private readonly AppDbContext _dbContext;

        public NodeSemanticSearchService(AppDbContext dbContext)
        {
            _dbContext = dbContext;
        }

        // Text search: stub for now (we'll implement later once we align with your IEmbeddingService)
        public Task<IReadOnlyList<MindMapNode>> SearchNodesAsync(
            Guid mindMapId,
            string query,
            int take = 10,
            CancellationToken cancellationToken = default)
        {
            // TODO: Implement using IEmbeddingService once we confirm its API.
            IReadOnlyList<MindMapNode> empty = Array.Empty<MindMapNode>();
            return Task.FromResult(empty);
        }

        // Related nodes: fully implemented using existing node embeddings
        public async Task<IReadOnlyList<MindMapNode>> GetRelatedNodesAsync(
            Guid mindMapId,
            Guid nodeId,
            int take = 10,
            CancellationToken cancellationToken = default)
        {
            // Get the target node
            var target = await _dbContext.MindMapNodes
                .FirstOrDefaultAsync(
                    n => n.MindMapId == mindMapId && n.Id == nodeId,
                    cancellationToken);

            if (target == null || target.Embedding == null || !target.Embedding.Any())
            {
                return Array.Empty<MindMapNode>();
            }

            // Load all *other* nodes with embeddings
            var nodes = await _dbContext.MindMapNodes
                .Where(n =>
                    n.MindMapId == mindMapId &&
                    n.Id != nodeId &&
                    n.Embedding != null &&
                    n.Embedding.Any())
                .ToListAsync(cancellationToken);

            var ranked = nodes
                .Select(n => new
                {
                    Node = n,
                    Score = EmbeddingSimilarity.CosineSimilarity(
                        target.Embedding,
                        n.Embedding)
                })
                .OrderByDescending(x => x.Score)
                .Take(take)
                .Select(x => x.Node)
                .ToList();

            return ranked;
        }
    }
}
