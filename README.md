# MindMapMe 🧠
AI-Powered Knowledge Mapping Platform

Turn ideas into structured visual knowledge graphs using semantic retrieval and AI-assisted reasoning.

Next.js • ASP.NET Core • PostgreSQL • RAG • Semantic Search

## Live Demo
Frontend
https://mindmapme-frontend.onrender.com

Backend API
https://mindmapme.onrender.com/swagger

## Demo Test Files

You can use the same documents shown in the demo video to test the system.

Sample files are available here:

https://github.com/NayanaBharadwaj/mindmapme/tree/main/sample-data

Upload these files in the application to generate mind maps and test semantic search.

## Main Features

- AI-powered mind map generation
- Interactive node editing and exploration
- Semantic search across mind map nodes
- AI-assisted question answering
- Evidence-backed responses using retrieved context
- Private mind maps per user
- Shareable links for viewing and exploring specific mind maps
- Responsive modern UI

## Tech Stack

- Frontend: Next.js, React, TypeScript
- Backend: ASP.NET Core (.NET 8), Entity Framework Core
- Database: PostgreSQL, pgvector
- AI: OpenAI embeddings, Retrieval-Augmented Generation (RAG)
- Deployment: Render

## Architecture

MindMapMe implements a Retrieval-Augmented Generation (RAG) pipeline.

Documents are transformed into structured mind map nodes and embedded using OpenAI embeddings.

When a user submits a query:

1. The query is converted into an embedding
2. pgvector performs similarity search across node embeddings
3. The most relevant nodes are retrieved
4. Retrieved context is provided to the language model

This enables:

- semantic search across ideas
- explainable AI responses
- evidence-backed answers

## Privacy Model

Each mind map is associated with an OwnerKey to ensure user-scoped access.

Users can:
- keep mind maps private
- share specific maps via generated links

## Local Development

Clone repository
git clone https://github.com/NayanaBharadwaj/mindmapme.git

Start backend:
- cd api
- dotnet run --project .\MindMapMe.Api\MindMapMe.Api.csproj

Start frontend:
- cd web
- pnpm install
- pnpm dev

## Future Improvements

- Support structured extraction from diagrams and mixed media (not only plain text)
- Real-time collaborative editing
- Export mind maps to PDF / Markdown
- Enhanced graph visualization

## Author

Built by  
**Nayana Agrahara Dattatri**
