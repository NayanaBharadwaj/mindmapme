namespace MindMapMe.Api.Dtos
{
    public class SemanticSearchRequest
    {
        public Guid MindMapId { get; set; }
        public string Query { get; set; } = string.Empty;
        public int TopK { get; set; } = 5;
    }

    public class SemanticSearchResultDto
    {
        public Guid Id { get; set; }
        public string Label { get; set; } = string.Empty;
        public double Score { get; set; }
    }
}
