using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MindMapMe.Application.AI;
using MindMapMe.Application.AI.Chat;
using MindMapMe.Domain.Entities;
using MindMapMe.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace MindMapMe.Infrastructure.AI.Chat
{
    /// <summary>
    /// Uses node embeddings to retrieve the most relevant nodes for a question,
    /// then calls OpenAI Chat API to answer based on those nodes.
    /// </summary>
    public sealed class MindMapChatService : IMindMapChatService
    {
        private readonly AppDbContext _dbContext;
        private readonly IEmbeddingService _embeddingService;
        private readonly HttpClient _httpClient;
        private readonly string _apiKey;
        private readonly string _chatModel;

        public MindMapChatService(
            AppDbContext dbContext,
            IEmbeddingService embeddingService,
            IConfiguration configuration)
        {
            _dbContext = dbContext;
            _embeddingService = embeddingService;

            _httpClient = new HttpClient();

            _apiKey = configuration["OpenAI:ApiKey"]
                      ?? throw new InvalidOperationException("OpenAI:ApiKey is missing from configuration.");

            // You can override this in appsettings / Azure config as OpenAI:ChatModel
            _chatModel = configuration["OpenAI:ChatModel"] ?? "gpt-4.1-mini";
        }

        // Backward-compatible overload (old interface/call sites)
        public Task<MindMapChatResult> AskAsync(
            Guid mindMapId,
            string question,
            int topK = 5,
            CancellationToken cancellationToken = default)
        {
            return AskAsync(mindMapId, question, topK, rootNodeId: null, cancellationToken);
        }

        public async Task<MindMapChatResult> AskAsync(
            Guid mindMapId,
            string question,
            int topK = 5,
            Guid? rootNodeId = null,
            CancellationToken cancellationToken = default)
        {
            if (mindMapId == Guid.Empty)
            {
                throw new ArgumentException("mindMapId is required.", nameof(mindMapId));
            }

            if (string.IsNullOrWhiteSpace(question))
            {
                throw new ArgumentException("question is required.", nameof(question));
            }

            /* if (topK <= 0)
            {
                topK = 5;
            } */

            // 1) Embed the question
            var queryEmbedding = await _embeddingService.GetEmbeddingAsync(question, cancellationToken);

            HashSet<Guid>? allowedIds = null;
            if (rootNodeId.HasValue && rootNodeId.Value != Guid.Empty)
            {
                allowedIds = await GetSubtreeNodeIdsAsync(mindMapId, rootNodeId.Value, cancellationToken);
            }

            // 2) Load nodes in this mind map that have embeddings
            var nodes = await _dbContext.MindMapNodes
                .Where(n =>
                    n.MindMapId == mindMapId &&
                    n.Embedding != null &&
                    n.Embedding.Any()
                    && (allowedIds == null || allowedIds.Contains(n.Id))
                    )
                .ToListAsync(cancellationToken);

            if (nodes.Count == 0)
            {
                // Fallback: still answer using raw node text/labels if embeddings aren't ready.
                var rawNodes = await _dbContext.MindMapNodes
                    .Where(n => n.MindMapId == mindMapId && (allowedIds == null || allowedIds.Contains(n.Id)))
                    .ToListAsync(cancellationToken);

                if (rawNodes.Count == 0)
                {
                    return new MindMapChatResult
                    {
                        Answer = allowedIds != null
                            ? "That selected map has no nodes yet. Import a file (or add nodes under that root) and try again."
                            : "This mind map has no nodes yet. Import a file or add nodes, then ask again."
                    };
                }

                // Build a lightweight context from the map content.
                // Keep it bounded so prompts don't explode.
                var contextParts = rawNodes
                    .Where(n => !string.IsNullOrWhiteSpace(n.Content) || !string.IsNullOrWhiteSpace(n.Text) || !string.IsNullOrWhiteSpace(n.Label))
                    .Take(25)
                    .Select((n, i) =>
                    {
                        var body =
                            n.Content ??
                            n.Text ??
                            n.Label ??
                            "";
                        if (body.Length > 700) body = body.Substring(0, 700) + "…";
                        return $"[{i + 1}] {n.Label}\n{body}";
                    });

                var fallbackContext = string.Join("\n\n", contextParts);

                // IMPORTANT: We still answer, but we are honest if the context doesn't contain it.
                var fallbackPrompt =
            $@"You are answering questions about a mind map.
            Use ONLY the context below. If the answer is not in the context, say so and give the closest helpful explanation, plus what info is missing.

            QUESTION:
            {question}

            CONTEXT:
            {fallbackContext}
            ";

                var llmAnswer = await CallChatApiAsync(fallbackPrompt, cancellationToken);

                // ✅ ALSO return context nodes so UI can highlight evidence even without embeddings
                var fallbackContextNodes = rawNodes
                    .Where(n =>
                        !string.IsNullOrWhiteSpace(n.Content) ||
                        !string.IsNullOrWhiteSpace(n.Text) ||
                        !string.IsNullOrWhiteSpace(n.Label))
                    .Take(12)
                    .Select((n, i) => new MindMapChatResult.ContextNode
                    {
                        Id = n.Id,
                        Label = n.Label ?? string.Empty,
                        Text = (n.Content ?? n.Text ?? n.Label) ?? string.Empty,
                        // No embeddings -> score is a heuristic placeholder so downstream logic works
                        Score = 0.5 - (i * 0.02)
                    })
                    .ToList();

                    return new MindMapChatResult
                    {
                        Answer = llmAnswer,
                        ContextNodes = fallbackContextNodes
                    };
            }

            if (topK <= 0) topK = 12;

            // 3) Rank nodes by cosine similarity
            var ranked = nodes
                .Select(n => new
                {
                    Node = n,
                    Score = EmbeddingSimilarity.CosineSimilarity(queryEmbedding, n.Embedding!)
                })
                .OrderByDescending(x => x.Score)
                .Take(topK)
                .ToList();

            var contextNodes = ranked.Select(x => new MindMapChatResult.ContextNode
            {
                Id = x.Node.Id,
                Label = x.Node.Label ?? string.Empty,
                Text = (x.Node.Content ?? x.Node.Text ?? x.Node.Label) ?? string.Empty,
                Score = x.Score
            }).ToList();

            // 4) Build prompt with context
            var sb = new StringBuilder();
            sb.AppendLine("You are an assistant helping the user understand their mind map.");
            sb.AppendLine("You are given a set of nodes that are most relevant to their question.");
            sb.AppendLine("Use ONLY these nodes as factual context. If something is unclear, say you are not sure.");
            sb.AppendLine();
            sb.AppendLine("Relevant nodes:");
            sb.AppendLine();

            foreach (var node in contextNodes)
            {
                sb.AppendLine($"- Node: {node.Label}");

                if (!string.IsNullOrWhiteSpace(node.Text) &&
                    !string.Equals(node.Text, node.Label, StringComparison.OrdinalIgnoreCase))
                {
                    sb.AppendLine($"  Details: {node.Text}");
                }
            }

            sb.AppendLine();
            sb.AppendLine($"User question: {question}");

            var systemPrompt =
                "You are a helpful assistant for a mind mapping app. " +
                "Answer clearly and concisely using only the provided nodes as context.";

            // 5) Call OpenAI Chat API
            var requestBody = new
            {
                model = _chatModel,
                messages = new[]
                {
                    new { role = "system", content = systemPrompt },
                    new { role = "user",   content = sb.ToString() }
                }
            };

            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                "https://api.openai.com/v1/chat/completions");

            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            request.Content = new StringContent(
                JsonSerializer.Serialize(requestBody),
                Encoding.UTF8,
                "application/json");

            using var response = await _httpClient.SendAsync(request, cancellationToken);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync(cancellationToken);

            var chatResponse = JsonSerializer.Deserialize<ChatCompletionResponse>(json)
                              ?? throw new InvalidOperationException("Failed to parse chat completion response.");

            var answer =
                chatResponse.choices?.FirstOrDefault()?.message?.content
                ?? "I couldn't generate an answer.";

            // 6) Return answer + context nodes
            return new MindMapChatResult
            {
                Answer = answer,
                ContextNodes = contextNodes
            };
        }

        // Minimal DTOs for OpenAI chat/completions response
        private sealed class ChatCompletionResponse
        {
            public List<Choice> choices { get; set; } = new();
        }

        private sealed class Choice
        {
            public Message message { get; set; } = new();
        }

        private sealed class Message
        {
            public string role { get; set; } = string.Empty;
            public string content { get; set; } = string.Empty;
        }

        private async Task<string> CallChatApiAsync(string userPrompt, CancellationToken cancellationToken)
        {
            var systemPrompt =
                "You are a helpful assistant for a mind mapping app. " +
                "Answer clearly and concisely using only the provided context.";

            var requestBody = new
            {
                model = _chatModel,
                messages = new[]
                {
                    new { role = "system", content = systemPrompt },
                    new { role = "user", content = userPrompt }
                }
            };

            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                "https://api.openai.com/v1/chat/completions");

            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            request.Content = new StringContent(
                JsonSerializer.Serialize(requestBody),
                Encoding.UTF8,
                "application/json");

            using var response = await _httpClient.SendAsync(request, cancellationToken);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync(cancellationToken);

            var chatResponse = JsonSerializer.Deserialize<ChatCompletionResponse>(json)
                              ?? throw new InvalidOperationException("Failed to parse chat completion response.");

            return chatResponse.choices?.FirstOrDefault()?.message?.content
                    ?? "I couldn't generate an answer.";
        }

        private async Task<HashSet<Guid>> GetSubtreeNodeIdsAsync(Guid mindMapId, Guid rootNodeId, CancellationToken ct)
        {
            var all = await _dbContext.MindMapNodes
                .Where(n => n.MindMapId == mindMapId)
                .Select(n => new { n.Id, n.ParentId })
                .ToListAsync(ct);

            var children = new Dictionary<Guid, List<Guid>>();
            foreach (var n in all)
            {
                if (n.ParentId == null) continue;
                if (!children.TryGetValue(n.ParentId.Value, out var list))
                {
                    list = new List<Guid>();
                    children[n.ParentId.Value] = list;
                }
                list.Add(n.Id);
            }

            var result = new HashSet<Guid>();
            var q = new Queue<Guid>();
            q.Enqueue(rootNodeId);

            while (q.Count > 0)
            {
                var cur = q.Dequeue();
                if (!result.Add(cur)) continue;
                if (children.TryGetValue(cur, out var kids))
                    foreach (var kid in kids) q.Enqueue(kid);
            }

            return result;
        }

    }
}
