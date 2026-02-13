using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using MindMapMe.Application.AI;
using Microsoft.Extensions.Configuration;

namespace MindMapMe.Infrastructure.AI;

/// <summary>
/// Calls the OpenAI embeddings API and returns the vector as float[].
/// This implementation owns its own HttpClient instance so that we don't
/// need any special HttpClient registration in DI – only IConfiguration.
/// </summary>
public sealed class OpenAIEmbeddingService : IEmbeddingService
{
    private readonly HttpClient _httpClient;
    private readonly string _apiKey;
    private readonly string _embeddingModel;

    public OpenAIEmbeddingService(IConfiguration configuration)
    {
        _httpClient = new HttpClient();

        _apiKey = configuration["OpenAI:ApiKey"]
                  ?? throw new InvalidOperationException("OpenAI:ApiKey is missing from configuration.");

        // If you change the key name in appsettings / Azure config,
        // keep this in sync.
        _embeddingModel = configuration["OpenAI:EmbeddingModel"] ?? "text-embedding-3-small";
    }

    public async Task<float[]> GetEmbeddingAsync(string text, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            throw new ArgumentException("Text must not be empty.", nameof(text));
        }

        var requestBody = new
        {
            model = _embeddingModel,
            input = text
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.openai.com/v1/embeddings");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
        request.Content = new StringContent(JsonSerializer.Serialize(requestBody), Encoding.UTF8, "application/json");

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);

        var embeddingResponse = JsonSerializer.Deserialize<EmbeddingResponse>(responseJson)
                               ?? throw new InvalidOperationException("Failed to parse embedding response.");

        if (embeddingResponse.data is null || embeddingResponse.data.Length == 0)
        {
            throw new InvalidOperationException("Embedding response did not contain any data.");
        }

        return embeddingResponse.data[0].embedding;
    }

    // DTOs that match the shape of the OpenAI embeddings response.
    private sealed class EmbeddingResponse
    {
        public EmbeddingData[] data { get; set; } = Array.Empty<EmbeddingData>();
    }

    private sealed class EmbeddingData
    {
        public float[] embedding { get; set; } = Array.Empty<float>();
    }
}
