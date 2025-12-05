namespace MindMapMe.Domain.Entities
{
    public class MindMapNode
    {
        public Guid Id { get; set; }
        public Guid MindMapId { get; set; }

        public string Label { get; set; } = string.Empty;

        public float PositionX { get; set; }
        public float PositionY { get; set; }

        public Guid? ParentId { get; set; }

        // 👇 NEW — embeddings stored as Postgres real[] array
        public float[]? Embedding { get; set; }
    }
}
