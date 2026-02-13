using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using MindMapMe.Domain.Entities;

namespace MindMapMe.Application.Search
{
    public interface ISemanticSearchService
    {
        Task<List<(MindMapNode node, double score)>> SearchNodesAsync(
            Guid mindMapId,
            string query,
            int topK);
    }
}
