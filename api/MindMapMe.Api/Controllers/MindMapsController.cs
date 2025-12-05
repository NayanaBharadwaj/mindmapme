using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using MindMapMe.Domain;
using MindMapMe.Infrastructure.Persistence;
using MindMapMe.Domain.Entities;


namespace MindMapMe.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class MindMapsController : ControllerBase
{
    private readonly AppDbContext _db;

    public MindMapsController(AppDbContext db)
    {
        _db = db;
    }

    // POST /api/mindmaps
    [HttpPost]
    public async Task<ActionResult<MindMapDto>> CreateMindMap([FromBody] CreateMindMapRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
        {
            return BadRequest("Title is required.");
        }

        var mindMap = new MindMap
        {
            Title = request.Title.Trim()
        };

        _db.MindMaps.Add(mindMap);
        await _db.SaveChangesAsync();

        var dto = new MindMapDto(mindMap.Id, mindMap.Title, mindMap.CreatedAt);

        // Returns 201 Created with Location header pointing to GET /api/mindmaps/{id}
        return CreatedAtAction(
            nameof(GetMindMapById),
            new { id = mindMap.Id },
            dto);
    }

    // GET /api/mindmaps/{id}
    [HttpGet("{id:guid}")]
    public async Task<ActionResult<MindMapDto>> GetMindMapById(Guid id)
    {
        var mindMap = await _db.MindMaps.FindAsync(id);

        if (mindMap is null)
        {
            return NotFound();
        }

        return new MindMapDto(mindMap.Id, mindMap.Title, mindMap.CreatedAt);
    }

    // GET /api/mindmaps
    [HttpGet]
    public async Task<ActionResult<IEnumerable<MindMapDto>>> GetMindMaps()
    {
        var items = await _db.MindMaps
            .OrderByDescending(m => m.CreatedAt)
            .Select(m => new MindMapDto(m.Id, m.Title, m.CreatedAt))
            .ToListAsync();

        return items;
    }

    // PUT /api/mindmaps/{id}
    [HttpPut("{id:guid}")]
    public async Task<ActionResult<MindMapDto>> UpdateMindMap(Guid id, [FromBody] UpdateMindMapRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
        {
            return BadRequest("Title is required.");
        }

        var mindMap = await _db.MindMaps.FindAsync(id);
        if (mindMap is null)
        {
            return NotFound();
        }

        mindMap.Title = request.Title.Trim();
        await _db.SaveChangesAsync();

        return new MindMapDto(mindMap.Id, mindMap.Title, mindMap.CreatedAt);
    }

    // DELETE /api/mindmaps/{id}
    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> DeleteMindMap(Guid id)
    {
        var mindMap = await _db.MindMaps.FindAsync(id);
        if (mindMap is null)
        {
            return NotFound();
        }

        _db.MindMaps.Remove(mindMap);
        await _db.SaveChangesAsync();

        // 204 No Content � standard response for a successful delete
        return NoContent();
    }
}

// Simple DTOs kept here for now to avoid extra files.
// Later we can move them into a separate folder if we want.
public record MindMapDto(Guid Id, string Title, DateTime CreatedAt);

public record CreateMindMapRequest(string Title);

public record UpdateMindMapRequest(string Title);
