# MindMapMe
MindMapMe turns raw documents into structured, inspectable knowledge maps.

## Live Demo
https://mindmapme-frontend.onrender.com

## Backend API
https://mindmapme.onrender.com/swagger

## Features
- Import documents into structured knowledge maps
- AI-assisted question answering
- Evidence-backed answers
- Semantic retrieval with embeddings
- Interactive node-based visualization

## Tech Stack
- Frontend: Next.js + React Flow
- Backend: ASP.NET Core Web API
- Database: PostgreSQL + pgvector
- AI: OpenAI embeddings + chat models
- Deployment: Render

## Architecture

MindMapMe uses a Retrieval-Augmented Generation (RAG) pipeline.  
Documents are converted into structured mind map nodes and embedded using OpenAI embeddings.  

User queries are embedded and matched against node embeddings using pgvector similarity search.  
The most relevant nodes are retrieved and used as context for LLM responses, enabling evidence-backed answers and explainable reasoning.
