using Microsoft.EntityFrameworkCore;
using MindMapMe.Infrastructure.Persistence;
using MindMapMe.Application.AI;
using MindMapMe.Infrastructure;
using MindMapMe.Infrastructure.AI;
using MindMapMe.Application.Search;
using MindMapMe.Infrastructure.Search;
using OpenAI;
using OpenAI.Embeddings;

var builder = WebApplication.CreateBuilder(args);
var configuration = builder.Configuration;

// ---------- Services / DI ----------

// MVC controllers
builder.Services.AddControllers();

// Swagger
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddInfrastructure(builder.Configuration);


// CORS – simple policy so local + Azure frontends can call the API
builder.Services.AddCors(options =>
{
    options.AddPolicy("Frontend", policy =>
    {
        policy
            .AllowAnyOrigin()   // you can restrict to specific origins later
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

// PostgreSQL DbContext
builder.Services.AddDbContext<AppDbContext>(options =>
{
    options.UseNpgsql(configuration.GetConnectionString("Default"));
});

// OpenAI Embedding client
builder.Services.AddSingleton<EmbeddingClient>(sp =>
{
    var apiKey =
        configuration["OpenAI:ApiKey"] ??
        configuration["OpenAI__ApiKey"];

    if (string.IsNullOrWhiteSpace(apiKey))
        throw new InvalidOperationException("OpenAI API key is not configured.");

    var model =
        configuration["OpenAI:EmbeddingModel"] ??
        configuration["OpenAI__EmbeddingModel"] ??
        "text-embedding-3-small";

    var client = new OpenAIClient(apiKey);
    return client.GetEmbeddingClient(model);
});

// AI + semantic search services
builder.Services.AddScoped<INodeSemanticSearchService, NodeSemanticSearchService>();
builder.Services.AddScoped<ISemanticSearchService, SemanticSearchService>();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}


// ---------- HTTP pipeline ----------

if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
    app.UseSwagger();
    app.UseSwaggerUI(c =>
    {
        c.SwaggerEndpoint("/swagger/v1/swagger.json", "MindMapMe API v1");
        c.RoutePrefix = "swagger";
    });
}
else
{
    app.UseSwagger();
    app.UseSwaggerUI(c =>
    {
        c.SwaggerEndpoint("/swagger/v1/swagger.json", "MindMapMe API v1");
        c.RoutePrefix = "swagger";
    });
}

// If you decide to force HTTPS later, you can re-enable this:
// app.UseHttpsRedirection();

// CORS for frontend
app.UseCors("Frontend");

// Routing + controllers
app.MapControllers();

app.Run();
