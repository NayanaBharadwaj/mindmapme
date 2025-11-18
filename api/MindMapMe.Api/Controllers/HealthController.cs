using Microsoft.AspNetCore.Mvc;

namespace MindMapMe.Api.Controllers;

[ApiController]
[Route("health")]
public class HealthController : ControllerBase
{
    [HttpGet("live")]
    public IActionResult Live() => Ok(new { status = "live" });

    [HttpGet("ready")]
    public IActionResult Ready() => Ok(new { status = "ready" });
}
