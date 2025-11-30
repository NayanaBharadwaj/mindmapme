using Microsoft.EntityFrameworkCore;

namespace MindMapMe.Infrastructure.Persistence;

public class ApplicationDbContext : DbContext
{
    public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options)
        : base(options)
    {
    }

    // We'll add DbSets (tables) later, e.g.
    // public DbSet<MindMap> MindMaps { get; set; } = default!;
}
