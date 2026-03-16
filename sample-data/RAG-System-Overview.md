# RAG System Overview

## The Problem
Large language models are powerful but unreliable when answering questions about private or evolving knowledge. Without grounding, answers may be fluent but incorrect.

## Retrieval-Augmented Generation (RAG)
RAG improves reliability by retrieving relevant context from documents before generating an answer.

A typical RAG pipeline includes:
- Document ingestion
- Text chunking
- Embedding generation
- Vector storage
- Semantic retrieval
- Prompt construction
- Answer generation
- Evidence attribution

## End-to-End Data Flow
1. Documents are ingested and normalized
2. Content is split into overlapping chunks
3. Each chunk is converted into an embedding vector
4. Vectors are stored in a vector database
5. User queries are embedded
6. Top-K chunks are retrieved using cosine similarity
7. Retrieved chunks are assembled into a prompt
8. The LLM generates a grounded answer

## Key Trade-offs
- Chunk size vs semantic precision
- Top-K retrieval vs latency
- Recall vs hallucination risk
- Precomputation vs runtime cost

## Common Failure Modes
- Hallucinations due to poor retrieval
- Stale embeddings after document updates
- Missing attribution for generated answers
- Overlapping chunks causing redundant context
