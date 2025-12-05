# MindMapMe 🧠

MindMapMe is a full-stack, AI-assisted mind-mapping app built to showcase modern web development skills.

It combines a .NET backend, a React/Next.js frontend, a relational database, and OpenAI for embeddings / smart features.

---

## ✨ Features

- Create mind maps and nested nodes (topics, sub-topics, ideas)
- Interactive canvas:
  - Drag nodes around
  - Pan the canvas
  - Multi-select nodes
  - Keyboard shortcuts
  - Undo / Redo
- CRUD API for mind maps and nodes
- Persistent storage in a SQL database
- OpenAI integration for:
  - Generating/storing embeddings for nodes (Day 8 work)
  - (Planned) semantic search and “related nodes” suggestions
- Clean, resume-friendly architecture and codebase

---

## 🧱 Tech Stack

**Backend**

- ASP.NET Core Web API
- Entity Framework Core
- C# 12 (or whatever your SDK supports)
- SQL Server / LocalDB (configurable via connection string)
- OpenAI API (for embeddings and future AI features)

**Frontend**

- Next.js (App Router)
- React
- TypeScript
- Tailwind CSS
- (Optional) shadcn/ui or similar component library

---

## 📁 Project Structure

> Adjust folder names if yours are slightly different.

```text
.
├── MindMapMe.Api/           # ASP.NET Core Web API
│   ├── Controllers/         # API controllers (e.g. MindMaps, MindMapNodes)
│   ├── Application/         # Services, DTOs, business logic
│   ├── Domain/              # Entities, value objects
│   ├── Infrastructure/      # EF Core DbContext, migrations, repositories
│   ├── appsettings.json     # Base configuration
│   └── ...
├── MindMapMe.Web/           # Next.js + React frontend
│   ├── app/                 # App Router pages (e.g. /mindmaps/[id]/page.tsx)
│   ├── components/          # Reusable UI components
│   ├── lib/                 # Client helpers, API client, types
│   └── ...
├── docs/                    # Day-by-day reports (Day 1–8) (optional)
└── README.md
