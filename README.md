# MindMapMe 🧠
AI-Powered Knowledge Mapping Platform.

Turn ideas into structured visual knowledge graphs.
- Next.js
- ASP.NET Core
- PostgreSQL
- RAG • Semantic Search

## MindMapMe
AI-powered mind mapping platform that converts unstructured ideas into structured knowledge graphs with semantic search.

MindMapMe helps users visually organize concepts while using AI-powered retrieval to explore relationships between ideas.

## Live Demo
https://mindmapme-frontend.onrender.com

## Backend API
https://mindmapme.onrender.com/swagger

## Main Features
- AI-powered mind map generation
- Interactive node editing and exploration
- Semantic search across mind map nodes
- Private mind maps per user
- Responsive modern UI
- AI-assisted question answering
- Evidence-backed answers

## Tech Stack
- Frontend: Next.js, React, TypeScript
- Backend: ASP.NET Core (.NET 8), Entity Framework Core
- Database: PostgreSQL, pgvector
- AI: OpenAI embeddings, Retrieval-Augmented Generation (RAG)
- Deployment: Render

## Architecture

MindMapMe uses a Retrieval-Augmented Generation (RAG) pipeline.  
Documents are converted into structured mind map nodes and embedded using OpenAI embeddings.  

User queries are embedded and matched against node embeddings using pgvector similarity search.  
The most relevant nodes are retrieved and used as context for LLM responses, enabling evidence-backed answers and explainable reasoning.

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
- npm install
- npm run dev

## Future Improvements
- Derive map even though there are other elements, such as diagrams, along with plain texts
- Real-time collaboration
- Export to PDF / Markdown
- Graph visualization enhancements

👩‍💻 Author
Built by
### Nayana Agrahara Dattatri
