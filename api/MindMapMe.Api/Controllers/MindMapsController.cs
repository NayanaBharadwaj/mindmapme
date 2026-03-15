using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using MindMapMe.Domain;
using MindMapMe.Infrastructure.Persistence;
using MindMapMe.Domain.Entities;
using MindMapMe.Application.AI.Chat;
using System.IO;
using System.Text;
using UglyToad.PdfPig;
using Microsoft.EntityFrameworkCore;
using MindMapMe.Application.AI;


namespace MindMapMe.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class MindMapsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IMindMapChatService _chatService;
    private readonly IEmbeddingService _embeddingService;

    public MindMapsController(
        AppDbContext db,
        IMindMapChatService chatService,
        IEmbeddingService embeddingService)
    {
        _db = db;
        _chatService = chatService;
        _embeddingService = embeddingService;
    }

    private string? GetOwnerKey()
    {
        return Request.Headers["X-Owner-Key"].FirstOrDefault();
    }

    private static List<string> SplitIntoSentences(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return new List<string>();

        var parts = System.Text.RegularExpressions.Regex
            .Split(text.Trim(), @"(?<=[\.!\?])\s+")
            .Select(s => s?.Trim())
            .Where(s => !string.IsNullOrWhiteSpace(s))
            // ✅ drop "sentences" that are just list numbering like "1." or "2)"
            .Where(s => !System.Text.RegularExpressions.Regex.IsMatch(s!, @"^\d+[\.\)]?$"))
            .ToList();

        return parts.Count > 0 ? parts : new List<string> { text.Trim() };
    }

    private static string MakeSnippet(string? sourceText, string sentence, int maxLen = 180)
    {
        if (string.IsNullOrWhiteSpace(sourceText))
            return sentence.Length <= maxLen ? sentence : sentence.Substring(0, maxLen);

        var src = sourceText.Trim();

        // If sentence exists in source, take a window around it
        var idx = src.IndexOf(sentence, StringComparison.OrdinalIgnoreCase);
        if (idx >= 0)
        {
            var start = Math.Max(0, idx - 40);
            var len = Math.Min(src.Length - start, Math.Max(sentence.Length + 80, maxLen));
            return src.Substring(start, len);
        }

        // Fallback: first maxLen chars
        return src.Length <= maxLen ? src : src.Substring(0, maxLen);
    }

    private static async Task<string> ExtractTextAsync(IFormFile file, string ext, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();

        if (ext is ".txt" or ".md")
        {
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            return await reader.ReadToEndAsync();
        }

        if (ext == ".pdf")
        {
            // PdfPig needs a seekable stream sometimes, so copy to MemoryStream
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms, ct);
            ms.Position = 0;

            var sb = new StringBuilder();
            using (var doc = PdfDocument.Open(ms))
            {
                foreach (var page in doc.GetPages())
                {
                    var pageText = page.Text;
                    if (!string.IsNullOrWhiteSpace(pageText))
                    {
                        sb.AppendLine(pageText);
                        sb.AppendLine();
                    }
                }
            }
            return sb.ToString();
        }

        throw new InvalidOperationException("Unsupported file type. Upload .txt, .md, or .pdf only.");
    }

    private static List<string> SplitIntoParagraphChunks(string text, int maxChars = 600)
    {
        var chunks = new List<string>();
        if (string.IsNullOrWhiteSpace(text)) return chunks;

        text = text.Replace("\r\n", "\n").Trim();
        var blocks = text.Split(new[] { "\n\n" }, StringSplitOptions.RemoveEmptyEntries)
                        .Select(b => b.Trim())
                        .Where(b => b.Length > 0)
                        .ToList();

        foreach (var block in blocks)
        {
            var lines = block.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
            if (lines.Count == 0) continue;

            bool IsBullet(string l) =>
                l.StartsWith("- ") || l.StartsWith("* ") || l.StartsWith("•") ||
                System.Text.RegularExpressions.Regex.IsMatch(l, @"^\d+[\.\)]\s+");

            // If this block looks like a heading + bullet list, create nodes per bullet
            if (lines.Count >= 2 && lines.Skip(1).Any(IsBullet))
            {
                var heading = IsBullet(lines[0]) ? null : lines[0];

                foreach (var l in lines)
                {
                    if (heading != null && l == heading) continue;

                    if (IsBullet(l))
                    {
                        var bulletText = heading != null ? $"{heading} — {l}" : l;
                        chunks.Add(bulletText.Length > maxChars ? bulletText.Substring(0, maxChars) : bulletText);
                    }
                    else if (heading == null)
                    {
                        // non-bullet block without a heading → keep as chunk
                        chunks.Add(l.Length > maxChars ? l.Substring(0, maxChars) : l);
                    }
                }

                continue;
            }

            // Normal paragraph block → keep as one chunk (or split if very long)
            var joined = string.Join("\n", lines);
            if (joined.Length <= maxChars)
            {
                chunks.Add(joined);
            }
            else
            {
                // split long blocks by sentence-ish boundaries
                var parts = System.Text.RegularExpressions.Regex.Split(joined, @"(?<=[\.\!\?])\s+");
                var buf = "";
                foreach (var p in parts)
                {
                    var candidate = string.IsNullOrEmpty(buf) ? p : (buf + " " + p);
                    if (candidate.Length > maxChars)
                    {
                        if (!string.IsNullOrWhiteSpace(buf)) chunks.Add(buf.Trim());
                        buf = p;
                    }
                    else buf = candidate;
                }
                if (!string.IsNullOrWhiteSpace(buf)) chunks.Add(buf.Trim());
            }
        }

        return chunks;
    }



    private static HashSet<string> Tokenize(string text)
    {
        return System.Text.RegularExpressions.Regex
            .Matches(text.ToLowerInvariant(), @"[a-z0-9]+")
            .Select(m => m.Value)
            .Where(w => w.Length >= 3) // ignore tiny words
            .ToHashSet();
    }

    private static int OverlapScore(string sentence, string? nodeText, string? nodeLabel)
    {
        var sTokens = Tokenize(sentence);
        if (sTokens.Count == 0) return 0;

        var nTokens = new HashSet<string>();
        if (!string.IsNullOrWhiteSpace(nodeText))
            nTokens.UnionWith(Tokenize(nodeText));
        if (!string.IsNullOrWhiteSpace(nodeLabel))
            nTokens.UnionWith(Tokenize(nodeLabel));

        if (nTokens.Count == 0) return 0;

        return sTokens.Intersect(nTokens).Count();
    }



    // POST /api/mindmaps
    [HttpPost]
    public async Task<ActionResult<MindMapDto>> CreateMindMap([FromBody] CreateMindMapRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
        {
            return BadRequest("Title is required.");
        }

        var ownerKey = GetOwnerKey();
        if (string.IsNullOrWhiteSpace(ownerKey))
        {
            return BadRequest("Missing X-Owner-Key header.");
        }

        var mindMap = new MindMap
        {
            Title = request.Title.Trim(),
            OwnerKey = ownerKey
        };

        _db.MindMaps.Add(mindMap);
        await _db.SaveChangesAsync();

        var dto = new MindMapDto(mindMap.Id, mindMap.Title, mindMap.CreatedAt);

        return CreatedAtAction(
            nameof(GetMindMapById),
            new { id = mindMap.Id },
            dto);
    }

    // GET /api/mindmaps/{id}
    [HttpGet("{id:guid}")]
    public async Task<ActionResult<MindMapDto>> GetMindMapById(Guid id)
    {
        var ownerKey = GetOwnerKey();
        if (string.IsNullOrWhiteSpace(ownerKey))
        {
            return BadRequest("Missing X-Owner-Key header.");
        }

        var mindMap = await _db.MindMaps
            .AsNoTracking()
            .FirstOrDefaultAsync(m => m.Id == id && m.OwnerKey == ownerKey);

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
        var ownerKey = GetOwnerKey();
        if (string.IsNullOrWhiteSpace(ownerKey))
        {
            return BadRequest("Missing X-Owner-Key header.");
        }

        var items = await _db.MindMaps
            .Where(m => m.OwnerKey == ownerKey)
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

        var ownerKey = GetOwnerKey();
        if (string.IsNullOrWhiteSpace(ownerKey))
        {
            return BadRequest("Missing X-Owner-Key header.");
        }

        var mindMap = await _db.MindMaps
            .FirstOrDefaultAsync(m => m.Id == id && m.OwnerKey == ownerKey);

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
        var ownerKey = GetOwnerKey();
        if (string.IsNullOrWhiteSpace(ownerKey))
        {
            return BadRequest("Missing X-Owner-Key header.");
        }

        var mindMap = await _db.MindMaps
            .FirstOrDefaultAsync(m => m.Id == id && m.OwnerKey == ownerKey);

        if (mindMap is null)
        {
            return NotFound();
        }

        _db.MindMaps.Remove(mindMap);
        await _db.SaveChangesAsync();

        return NoContent();
    }

    // 🧠 Chat with this mind map (non-streaming JSON)
    // POST /api/mindmaps/{mindMapId}/chat
    [HttpPost("{mindMapId:guid}/chat")]
    public async Task<ActionResult<MindMapChatResponseDto>> Chat(
        Guid mindMapId,
        [FromBody] MindMapChatRequestDto request,
        CancellationToken cancellationToken)
    {
        var ownerKey = GetOwnerKey();
        if (string.IsNullOrWhiteSpace(ownerKey))
        {
            return BadRequest("Missing X-Owner-Key header.");
        }

        var mindMap = await _db.MindMaps
        .AsNoTracking()
        .FirstOrDefaultAsync(m => m.Id == mindMapId && m.OwnerKey == ownerKey, cancellationToken);

        if (mindMap is null)
        {
            return NotFound("Mind map not found.");
        }

        if (mindMapId == Guid.Empty)
        {
            return BadRequest("mindMapId is required.");
        }

        if (request is null || string.IsNullOrWhiteSpace(request.Question))
        {
            return BadRequest("Question is required.");
        }

        var result = await _chatService.AskAsync(
            mindMapId,
            request.Question,
            request.TopK <= 0 ? 5 : request.TopK,
            request.RootNodeId,
            cancellationToken);

        var response = new MindMapChatResponseDto
        {
            Answer = result.Answer,
            ContextNodes = result.ContextNodes.Select(n => new MindMapChatContextNodeDto
            {
                Id = n.Id,
                Label = n.Label,
                Text = n.Text,
                Score = n.Score
            }).ToList()
        };
        // Day 14: build per-sentence evidence from the retrieved context nodes
        var answerText = response.Answer ?? string.Empty;
        var sentences = SplitIntoSentences(answerText);

        // Sort context nodes by score descending (best evidence first)
        var contextSorted = response.ContextNodes
            .OrderByDescending(n => n.Score)
            .ToList();

        var evidenceBySentence = new List<SentenceEvidenceDto>();

        for (int i = 0; i < sentences.Count; i++)
        {
            var sentence = sentences[i];

            // Take the top 2 context nodes as evidence for each sentence (simple & stable)
            // Pick evidence nodes that actually match this sentence (by word overlap)
            var topEvidenceNodes = contextSorted
                .Select(n => new { Node = n, Match = OverlapScore(sentence, n.Text, n.Label) })
                .OrderByDescending(x => x.Match)
                .ThenByDescending(x => x.Node.Score)
                .Where(x => x.Match > 0)
                .Take(3) // 2 or 3 is fine; 3 looks nicer in UI
                .Select(x => x.Node)
                .ToList();

            // Fallback: if nothing matched, use top 2 global nodes (better than empty UI)
            if (topEvidenceNodes.Count == 0)
            {
                topEvidenceNodes = contextSorted.Take(2).ToList();
            }


            var evidence = topEvidenceNodes.Select(n => new EvidenceSpanDto
            {
                TextSpan = MakeSnippet(n.Text, sentence),
                NodeId = n.Id,
                ChunkId = null,
                Score = n.Score
            }).ToList();

            evidenceBySentence.Add(new SentenceEvidenceDto
            {
                SentenceIndex = i,
                Sentence = sentence,
                Evidence = evidence
            });
        }

        response.EvidenceBySentence = evidenceBySentence;

        return Ok(response);
    }

    // 🧠 NEW: Streaming chat via SSE
    // GET /api/mindmaps/{mindMapId}/chat/stream?question=...&topK=5
    [HttpGet("{mindMapId:guid}/chat/stream")]
    public async Task StreamChat(
        Guid mindMapId,
        [FromQuery] string question,
        [FromQuery] int topK = 5,
        [FromQuery] Guid? rootNodeId = null,
        CancellationToken cancellationToken = default)
    {
        if (mindMapId == Guid.Empty)
        {
            Response.StatusCode = 400;
            await Response.WriteAsync("mindMapId is required", cancellationToken);
            return;
        }

        if (string.IsNullOrWhiteSpace(question))
        {
            Response.StatusCode = 400;
            await Response.WriteAsync("question is required", cancellationToken);
            return;
        }
        
        // SSE headers
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["Content-Type"] = "text/event-stream";
        Response.Headers["X-Accel-Buffering"] = "no";

        HttpContext.Features
            .Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()
            ?.DisableBuffering();

        // Use the existing chat service to get the full answer (RAG + OpenAI)
        var result = await _chatService.AskAsync(
            mindMapId,
            question,
            topK <= 0 ? 5 : topK,
            rootNodeId,
            cancellationToken);

        var answer = result.Answer ?? string.Empty;

        // Stream the answer in small chunks so the UI can show it progressively.
        const int chunkSize = 40; // characters per chunk (tune as you like)

        for (var i = 0; i < answer.Length; i += chunkSize)
        {
            var length = Math.Min(chunkSize, answer.Length - i);
            var chunk = answer.Substring(i, length);

            await Response.WriteAsync($"data: {chunk}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
        }

        // Signal completion
        await Response.WriteAsync("data: [DONE]\n\n", cancellationToken);
        await Response.Body.FlushAsync(cancellationToken);
    }

    // 🧪 Test SSE streaming endpoint (fake chunks)
    // GET /api/mindmaps/{mindMapId}/chat/stream-test
    [HttpGet("{mindMapId:guid}/chat/stream-test")]
    public async Task StreamTest(Guid mindMapId, CancellationToken cancellationToken)
    {
        // SSE headers
        Response.Headers.Add("Cache-Control", "no-cache");
        Response.Headers.Add("Content-Type", "text/event-stream");
        Response.Headers.Add("X-Accel-Buffering", "no");

        HttpContext.Features
            .Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()
            ?.DisableBuffering();

        // Simulate 5 streamed chunks
        for (int i = 1; i <= 5; i++)
        {
            var msg = $"chunk {i} from mindmap {mindMapId}";
            await Response.WriteAsync($"data: {msg}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);

            await Task.Delay(500, cancellationToken);
        }

        // End of stream
        await Response.WriteAsync("data: [DONE]\n\n", cancellationToken);
        await Response.Body.FlushAsync(cancellationToken);
    }

    [HttpPost("{mindMapId:guid}/summary")]
    public async Task<IActionResult> SummarizeMindMap(
        Guid mindMapId,
        [FromQuery] Guid? rootNodeId,
        CancellationToken cancellationToken)
    {
        if (mindMapId == Guid.Empty)
            return BadRequest("mindMapId is required.");

        if (rootNodeId == null || rootNodeId == Guid.Empty)
            return BadRequest("rootNodeId is required.");

        var ownerKey = GetOwnerKey();
        if (string.IsNullOrWhiteSpace(ownerKey))
        {
            return BadRequest("Missing X-Owner-Key header.");
        }

        var mindMap = await _db.MindMaps
        .AsNoTracking()
        .FirstOrDefaultAsync(m => m.Id == mindMapId && m.OwnerKey == ownerKey, cancellationToken);

        if (mindMap is null)
        {
            return NotFound("Mind map not found.");
        }

        // 1) Load id + parent + text fields for ALL nodes once
        var all = await _db.MindMapNodes
            .AsNoTracking()
            .Where(n => n.MindMapId == mindMapId)
            .Select(n => new
            {
                n.Id,
                n.ParentId,
                n.Label,
                n.Text,
                n.Content
            })
            .ToListAsync(cancellationToken);

        if (all.Count == 0)
            return Ok(new { summary = "This mind map is empty." });

        // 2) Build subtree IDs for the chosen root
        var children = new Dictionary<Guid, List<Guid>>();
        foreach (var n in all)
        {
            if (n.ParentId == null) continue;
            var p = n.ParentId.Value;
            if (!children.TryGetValue(p, out var list))
            {
                list = new List<Guid>();
                children[p] = list;
            }
            list.Add(n.Id);
        }

        var allowed = new HashSet<Guid>();
        var q = new Queue<Guid>();
        q.Enqueue(rootNodeId.Value);

        while (q.Count > 0)
        {
            var cur = q.Dequeue();
            if (!allowed.Add(cur)) continue;
            if (children.TryGetValue(cur, out var kids))
            {
                foreach (var k in kids) q.Enqueue(k);
            }
        }

        // If the root doesn’t exist in this mindmap, subtree will be just root id; validate:
        if (!all.Any(x => x.Id == rootNodeId.Value))
            return BadRequest("rootNodeId not found in this mind map.");

        // 3) Take only subtree nodes, build a bounded “content dump” for the LLM to summarize
        var subtree = all.Where(n => allowed.Contains(n.Id)).ToList();

        if (subtree.Count == 0)
            return Ok(new { summary = "That selected map is empty." });

        string Clip(string s, int max)
            => string.IsNullOrWhiteSpace(s) ? "" : (s.Length <= max ? s : s.Substring(0, max) + "…");

        var content = string.Join("\n",
            subtree
                .Select(n =>
                {
                    var label = (n.Label ?? "").Trim();
                    var body = (n.Content ?? n.Text ?? "").Trim();
                    body = Clip(body, 700);
                    label = Clip(label, 140);

                    if (string.IsNullOrWhiteSpace(label) && string.IsNullOrWhiteSpace(body))
                        return null;

                    if (string.IsNullOrWhiteSpace(body)) return $"- {label}";
                    if (string.IsNullOrWhiteSpace(label)) return $"- {body}";
                    return $"- {label}: {body}";
                })
                .Where(x => x != null)!
                .Take(80) // safety cap
        );

        // 4) Ask the chat service to summarize THIS subtree only.
        // IMPORTANT: we use a normal topK (not 0) so AskAsync actually includes context nodes.
        var summary = await _chatService.AskAsync(
            mindMapId,
            "Summarize this selected map in 5–7 concise bullet points. Focus on main ideas, structure, and key takeaways.\n\n" + content,
            topK: 12,
            rootNodeId: rootNodeId,
            cancellationToken: cancellationToken);

        return Ok(new { summary = summary.Answer });
    }

    /* [HttpPost("maintenance/cleanup-orphan-nodes")]
    public async Task<IActionResult> CleanupOrphanNodes(CancellationToken ct)
    {
        // Deletes MindMapNodes whose MindMapId does not exist in MindMaps
        var deleted = await _db.Database.ExecuteSqlRawAsync(@"
            DELETE FROM ""MindMapNodes"" n
            WHERE NOT EXISTS (
                SELECT 1 FROM ""MindMaps"" m WHERE m.""Id"" = n.""MindMapId""
            );
        ", ct);

        return Ok(new { deleted });
    } */

    // POST: api/MindMaps/{mindMapId}/import/{rootNodeId}/connections
    [HttpPost("{mindMapId:guid}/import/{rootNodeId:guid}/connections")]
    public async Task<IActionResult> FindImportConnections(
        Guid mindMapId,
        Guid rootNodeId,
        CancellationToken ct = default)
    {
        var ownerKey = GetOwnerKey();
        if (string.IsNullOrWhiteSpace(ownerKey))
        {
            return BadRequest("Missing X-Owner-Key header.");
        }

        var mindMap = await _db.MindMaps
        .AsNoTracking()
        .FirstOrDefaultAsync(m => m.Id == mindMapId && m.OwnerKey == ownerKey, ct);

        if (mindMap is null)
        {
            return NotFound("Mind map not found.");
        }
        // 1) Get imported nodes under this root (root + children)
        var importedNodes = await _db.MindMapNodes
            .AsNoTracking()
            .Where(n => n.MindMapId == mindMapId && (n.Id == rootNodeId || n.ParentId == rootNodeId))
            .Select(n => new { n.Id, n.Label })
            .ToListAsync(ct);

        if (importedNodes.Count == 0)
            return Ok(new { connections = Array.Empty<object>() });

        // 2) For each imported node, call the existing related endpoint/service logic
        // We'll reuse the SAME query logic your /related endpoint uses by calling the DB directly here.

        // Get embeddings for all nodes in the map once (performance)
        var allNodes = await _db.MindMapNodes
            .AsNoTracking()
            .Where(n => n.MindMapId == mindMapId)
            .Select(n => new { n.Id, n.Label, n.Embedding, n.ParentId })
            .ToListAsync(ct);

        // helper local funcs
        static bool IsGenericHub(string? label)
        {
            if (string.IsNullOrWhiteSpace(label)) return true;
            var s = label.Trim().ToLowerInvariant();
            return s is "overview" or "summary" or "key features" or "features"
                || s.Contains("proposed solution")
                || s.Contains("introduction")
                || s.Contains("conclusion");
        }

        static double CosineSimilarity(float[] a, float[] b)
        {
            double dot = 0, magA = 0, magB = 0;
            for (int i = 0; i < a.Length; i++)
            {
                dot += a[i] * b[i];
                magA += a[i] * a[i];
                magB += b[i] * b[i];
            }
            var denom = Math.Sqrt(magA) * Math.Sqrt(magB);
            return denom == 0 ? 0 : dot / denom;
        }

        const double threshold = 0.55;

        var connections = new List<object>();
        var seen = new HashSet<Guid>();

        foreach (var src in allNodes.Where(n => n.Id == rootNodeId || n.ParentId == rootNodeId))
        {
            if (src.Embedding == null) continue;

            var matches = allNodes
                .Where(t => t.Id != src.Id)
                .Where(t => t.Embedding != null)
                .Where(t => !IsGenericHub(t.Label))
                // don't recommend other imported nodes
                .Where(t => t.Id != rootNodeId && t.ParentId != rootNodeId)
                .Select(t => new
                {
                    targetId = t.Id,
                    targetTitle = t.Label,
                    similarity = CosineSimilarity(src.Embedding!, t.Embedding!)
                })
                .Where(x => x.similarity >= threshold)
                .OrderByDescending(x => x.similarity)
                .Take(2)
                .ToList();

            foreach (var m in matches)
            {
                if (seen.Add(m.targetId))
                {
                    connections.Add(new
                    {
                        sourceNodeId = src.Id,
                        sourceTitle = src.Label,
                        targetNodeId = m.targetId,
                        targetTitle = m.targetTitle,
                        similarity = m.similarity
                    });
                }
            }
        }

        // best overall first
        connections = connections
            .OrderByDescending(x => (double)x.GetType().GetProperty("similarity")!.GetValue(x)!)
            .Take(10)
            .ToList();

        return Ok(new { connections });
    }
    public class MindMapImportRequest
    {
        public IFormFile File { get; set; } = default!;
    }
    // POST /api/mindmaps/{mindMapId}/import  (multipart/form-data, field name: file)
    [HttpPost("{mindMapId:guid}/import")]
    [Consumes("multipart/form-data")]
    
    public async Task<IActionResult> Import(
        Guid mindMapId,
        [FromForm] MindMapImportRequest request,
        CancellationToken cancellationToken = default)
    {
        var file = request.File;

        if (mindMapId == Guid.Empty) return BadRequest("mindMapId is required.");
        if (file is null || file.Length == 0) return BadRequest("file is required.");

        var ownerKey = GetOwnerKey();
        if (string.IsNullOrWhiteSpace(ownerKey))
        {
            return BadRequest("Missing X-Owner-Key header.");
        }

        var mindMap = await _db.MindMaps
            .FirstOrDefaultAsync(m => m.Id == mindMapId && m.OwnerKey == ownerKey, cancellationToken);

        if (mindMap is null) return NotFound("Mind map not found.");

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        var text = await ExtractTextAsync(file, ext, cancellationToken);

        if (string.IsNullOrWhiteSpace(text))
        {
            return BadRequest("No text could be extracted (this PDF may be image-only).");
        }
        
        var existing = await _db.MindMapNodes
            .Where(n => n.MindMapId == mindMapId)
            .Select(n => new { n.PositionX, n.PositionY })
            .ToListAsync(cancellationToken);

        var maxX = existing.Count == 0 ? 0 : existing.Max(n => n.PositionX);
        var maxY = existing.Count == 0 ? 0 : existing.Max(n => n.PositionY);

        // Place the imported branch BELOW the current map (prevents overlap)
        var rootX = maxX;          // keep roughly aligned horizontally
        var rootY = maxY + 600;    // push down with padding


        // Create a root node named after the file
        var root = new MindMapNode
        {
            MindMapId = mindMapId,
            Label = $"📄 Imported: {Path.GetFileName(file.FileName)}",
            Text = null,
            Content = text.Trim(),
            ParentId = null,
            PositionX = rootX,
            PositionY = rootY
        };

        root.Id = Guid.NewGuid();
        // Don’t embed during import — keep import fast.
        // Embeddings can be computed later (or on-demand) if needed.
        root.Embedding = null;

        /* _db.MindMapNodes.Add(root);
        _db.MindMapNodes.AddRange(children);
        await _db.SaveChangesAsync(cancellationToken); */

        // Create child nodes from paragraphs (keeps search + evidence useful)
        var chunks = SplitIntoParagraphChunks(text, maxChars: 600)
            .Take(60) // safety cap
            .ToList();

        // simple layout: 2 columns under root
        const int xGap = 420;
        const int yGap = 180;

        var children = new List<MindMapNode>();
        for (int i = 0; i < chunks.Count; i++)
        {
            var chunk = chunks[i];
            var label = chunk.Length <= 80 ? chunk : chunk.Substring(0, 80) + "…";

            var col = i % 2;
            var row = i / 2;

            var child = new MindMapNode
            {
                Id = Guid.NewGuid(),
                MindMapId = mindMapId,
                ParentId = root.Id,
                Label = label,
                Text = chunk,
                Content = chunk,
                PositionX = rootX + (col == 0 ? -1 : 1) * xGap,
                PositionY = rootY + 200 + row * yGap
            };

            // Don’t embed during import — keep import fast.
            child.Embedding = null;

            children.Add(child);

        }

        _db.MindMapNodes.Add(root);
        _db.MindMapNodes.AddRange(children);
        await _db.SaveChangesAsync(cancellationToken);


        /* _db.MindMapNodes.AddRange(children);
        await _db.SaveChangesAsync(cancellationToken); */

        return Ok(new
        {
            rootNodeId = root.Id,
            createdNodes = 1 + children.Count
        });
    }

}

// Simple DTOs kept here for now to avoid extra files.
// Later we can move them into a separate folder if we want.
public record MindMapDto(Guid Id, string Title, DateTime CreatedAt);

public record CreateMindMapRequest(string Title);

public record UpdateMindMapRequest(string Title);

// Chat request/response DTOs for the API
public class MindMapChatRequestDto
{
    public string Question { get; set; } = string.Empty;
    public int TopK { get; set; } = 5;
    public Guid? RootNodeId { get; set; }
}

public class MindMapChatResponseDto
{
    public string Answer { get; set; } = string.Empty;
    public List<MindMapChatContextNodeDto> ContextNodes { get; set; } = new();
    public List<SentenceEvidenceDto> EvidenceBySentence { get; set; } = new();
}

public class MindMapChatContextNodeDto
{
    public Guid Id { get; set; }
    public string Label { get; set; } = string.Empty;
    public string? Text { get; set; }
    public double Score { get; set; }
}

public class EvidenceSpanDto
{
    public string TextSpan { get; set; } = "";
    public Guid NodeId { get; set; }          
    public Guid? ChunkId { get; set; }
    public double Score { get; set; }
}

public class SentenceEvidenceDto
{
    public int SentenceIndex { get; set; }
    public string Sentence { get; set; } = "";
    public List<EvidenceSpanDto> Evidence { get; set; } = new();
}

