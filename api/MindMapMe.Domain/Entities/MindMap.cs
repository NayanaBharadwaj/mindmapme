namespace MindMapMe.Domain.Entities
{
    public class MindMap
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public string Title { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

        public string OwnerKey { get; set; } = string.Empty;

        public List<MindMapNode> Nodes { get; set; } = new();
    }
}


