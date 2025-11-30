using Microsoft.EntityFrameworkCore;
using MindMapMe.Domain;

namespace MindMapMe.Infrastructure.Persistence;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options)
        : base(options)
    {
    }

    public DbSet<MindMap> MindMaps { get; set; } = null!;
}
