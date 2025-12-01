using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using MindMapMe.Domain;
using MindMapMe.Infrastructure.Persistence;

namespace MindMapMe.Api.Controllers;

[ApiController]
[Route("api/mindmaps")]
public class MindMapsController : ControllerBase
{
    private readonly AppDbContext _db;

    public MindMapsController(AppDbContext db)
    {
        _db = db;
    }

    // GET /api/mindmaps
    [HttpGet]
    public async Task<ActionResult<IEnumerable<MindMapDto>>> GetAll()
    {
        var mindMaps = await _db.MindMaps
            .OrderByDescending(m => m.CreatedAt)
            .Select(m => new MindMapDto(m.Id, m.Title, m.CreatedAt))
            .ToListAsync();

        return Ok(mindMaps);
    }

    // GET /api/mindmaps/{id}
    [HttpGet("{id:guid}")]
    public async Task<ActionResult<MindMapDto>> GetById(Guid id)
    {
        var mindMap = await _db.MindMaps.FindAsync(id);
        if (mindMap is null)
        {
            return NotFound();
        }

        var dto = new MindMapDto(mindMap.Id, mindMap.Title, mindMap.CreatedAt);
        return Ok(dto);
    }

    // POST /api/mindmaps
    [HttpPost]
    public async Task<ActionResult<MindMapDto>> Create(CreateMindMapRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
        {
            return BadRequest("Title is required.");
        }

        var mindMap = new MindMap
        {
            Title = request.Title.Trim()
            // Id + CreatedAt are set by the entity defaults
        };

        _db.MindMaps.Add(mindMap);
        await _db.SaveChangesAsync();

        var dto = new MindMapDto(mindMap.Id, mindMap.Title, mindMap.CreatedAt);

        return CreatedAtAction(
            nameof(GetById),
            new { id = mindMap.Id },
            dto);
    }
}

public record MindMapDto(Guid Id, string Title, DateTime CreatedAt);
public record CreateMindMapRequest(string Title);
