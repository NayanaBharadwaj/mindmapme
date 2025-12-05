namespace MindMapMe.Application.AI
{
    public interface IEmbeddingService
    {
        Task<float[]> GetEmbeddingAsync(string text, CancellationToken cancellationToken = default);
    }
}
