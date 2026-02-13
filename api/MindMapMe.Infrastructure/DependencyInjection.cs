using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using MindMapMe.Application.AI;
using MindMapMe.Application.AI.Chat;          
using MindMapMe.Application.Search;
using MindMapMe.Infrastructure.AI;
using MindMapMe.Infrastructure.AI.Chat;     
using MindMapMe.Infrastructure.Search;


namespace MindMapMe.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        // Embeddings + semantic search
        services.AddScoped<IEmbeddingService, OpenAIEmbeddingService>();
        services.AddScoped<ISemanticSearchService, SemanticSearchService>();
        services.AddScoped<IMindMapChatService, MindMapChatService>();

        // If you have other infrastructure registrations (DbContext, repositories, etc.)
        // they stay here as well in your real file.

        return services;
    }
}
