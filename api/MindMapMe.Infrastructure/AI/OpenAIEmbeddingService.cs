using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using MindMapMe.Application.AI;

namespace MindMapMe.Infrastructure.AI
{
    public class OpenAIEmbeddingService : IEmbeddingService
    {
        private readonly HttpClient _httpClient;
        private readonly string _apiKey;

        public OpenAIEmbeddingService(HttpClient httpClient, IConfiguration configuration)
        {
            _httpClient = httpClient;

            _apiKey = configuration["OpenAI:ApiKey"]
                      ?? throw new InvalidOperationException("OpenAI:ApiKey is not configured.");

            _httpClient.DefaultRequestHeaders.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _apiKey);
        }

        public async Task<float[]> GetEmbeddingAsync(string text, CancellationToken cancellationToken = default)
        {
            if (string.IsNullOrWhiteSpace(text))
            return Array.Empty<float>();

            var body = new
            {
                model = "text-embedding-3-small",
                input = text
            };

            using var response = await _httpClient.PostAsJsonAsync(
                "https://api.openai.com/v1/embeddings",
                body,
                cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                // Read the body for logging / debugging
                var content = await response.Content.ReadAsStringAsync(cancellationToken);
                Console.WriteLine($"OpenAI embeddings call failed: {(int)response.StatusCode} {response.StatusCode}");
                Console.WriteLine(content);

                // Graceful degradation: for common quota / auth issues, just return empty embedding
                if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests ||    // 429
                    response.StatusCode == System.Net.HttpStatusCode.PaymentRequired ||    // 402 - no quota
                    response.StatusCode == System.Net.HttpStatusCode.Forbidden ||          // 403 - project/permissions
                    response.StatusCode == System.Net.HttpStatusCode.Unauthorized)         // 401 - bad key
                {
                    // Let the app continue; node will be created without an embedding
                    return Array.Empty<float>();
                }

                // For anything else, still throw so we notice unexpected bugs
                response.EnsureSuccessStatusCode();
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var json = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

            var embedding = json.RootElement
            .GetProperty("data")[0]
            .GetProperty("embedding")
            .EnumerateArray()
            .Select(e => e.GetSingle())
            .ToArray();

            return embedding;
        }

    }
}
