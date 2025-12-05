using MindMapMe.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql.EntityFrameworkCore.PostgreSQL;
using MindMapMe.Application.AI;
using MindMapMe.Infrastructure.AI;


var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCors(options =>
{
    options.AddPolicy("Frontend", policy =>
    {
        policy.WithOrigins("http://localhost:3000")
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});


// Add services
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddHttpClient<IEmbeddingService, OpenAIEmbeddingService>();
builder.Services.AddScoped<INodeSemanticSearchService, NodeSemanticSearchService>();


// Add DbContext
builder.Services.AddDbContext<AppDbContext>(options =>
{
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default"));
});

// Build app
var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}
//app.UseHttpsRedirection();

app.UseCors("Frontend");
app.MapControllers();
app.Run();
