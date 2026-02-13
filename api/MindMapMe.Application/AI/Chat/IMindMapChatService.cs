using System;
using System.Threading;
using System.Threading.Tasks;

namespace MindMapMe.Application.AI.Chat
{
    public interface IMindMapChatService
    {
        Task<MindMapChatResult> AskAsync(
            Guid mindMapId,
            string question,
            int topK = 5,
            Guid? rootNodeId = null,
            CancellationToken cancellationToken = default);
    }

    public class MindMapChatResult
    {
        public string Answer { get; set; } = string.Empty;
        public List<ContextNode> ContextNodes { get; set; } = new();

        public class ContextNode
        {
            public Guid Id { get; set; }
            public string Label { get; set; } = string.Empty;
            public string? Text { get; set; }
            public double Score { get; set; }
        }
    }
}
