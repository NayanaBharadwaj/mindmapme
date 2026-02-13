using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using MindMapMe.Application.Search;
using MindMapMe.Domain.Entities;

namespace MindMapMe.Api.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class SearchController : ControllerBase
    {
        private readonly ISemanticSearchService _semanticSearchService;

        public SearchController(ISemanticSearchService semanticSearchService)
        {
            _semanticSearchService = semanticSearchService;
        }

        /// <summary>
        /// Semantic search over nodes in a single mind-map.
        /// </summary>
        /// <param name="mindMapId">Id of the mind-map to search in.</param>
        /// <param name="query">User’s natural-language query.</param>
        /// <param name="topK">Maximum number of results to return (default 10).</param>
        [HttpGet("nodes")]
        public async Task<ActionResult<IEnumerable<MindMapNodeSearchResultDto>>> SearchNodes(
            [FromQuery] Guid mindMapId,
            [FromQuery] string query,
            [FromQuery] int topK = 10)
        {
            if (mindMapId == Guid.Empty)
                return BadRequest("mindMapId is required.");

            if (string.IsNullOrWhiteSpace(query))
                return BadRequest("query is required.");

            if (topK <= 0)
                topK = 10;

            // This currently returns List<(MindMapNode node, double score)>
            var nodesWithScores = await _semanticSearchService.SearchNodesAsync(mindMapId, query, topK);

            // Map (node, score) -> DTOs for the API response
            var result = nodesWithScores
                .Select(ns => new MindMapNodeSearchResultDto
                {
                    Id        = ns.node.Id,
                    MindMapId = ns.node.MindMapId,
                    Label     = ns.node.Label,
                    PositionX = ns.node.PositionX,
                    PositionY = ns.node.PositionY,
                    ParentId  = ns.node.ParentId,
                    Score     = ns.score
                })
                .ToList();

            return Ok(result);
        }
    }

    // DTO specifically for search responses.
    public class MindMapNodeSearchResultDto
    {
        public Guid Id { get; set; }
        public Guid MindMapId { get; set; }
        public string Label { get; set; } = string.Empty;
        public float PositionX { get; set; }
        public float PositionY { get; set; }
        public Guid? ParentId { get; set; }

        // optional: expose the similarity score
        public double Score { get; set; }
    }
}
