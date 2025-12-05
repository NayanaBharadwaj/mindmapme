using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MindMapMe.Domain.Entities;

namespace MindMapMe.Application.AI
{
    public interface INodeSemanticSearchService
    {
        Task<IReadOnlyList<MindMapNode>> SearchNodesAsync(
            Guid mindMapId,
            string query,
            int take = 10,
            CancellationToken cancellationToken = default
        );

        Task<IReadOnlyList<MindMapNode>> GetRelatedNodesAsync(
            Guid mindMapId,
            Guid nodeId,
            int take = 10,
            CancellationToken cancellationToken = default
        );
    }
}
