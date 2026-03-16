# Embeddings and Semantic Retrieval

## Why Embeddings Matter
Embeddings map text into a high-dimensional vector space where semantically similar content is closer together. This allows meaning-based retrieval rather than keyword matching.

## Chunking Strategy
Chunking strongly affects retrieval quality.

Typical configuration:
- Chunk size: 800–1200 tokens
- Overlap: 10–20%

Too-small chunks lose context. Too-large chunks reduce recall.

## Vector Search
Each chunk embedding is stored in a vector database.

Common approaches:
- Flat cosine similarity search
- Approximate indexes such as IVFFLAT

Cosine similarity is commonly used to rank relevance.

## Query Execution Flow
1. Embed the user query
2. Perform vector similarity search
3. Retrieve Top-K relevant chunks
4. Rank and filter retrieved context
5. Pass selected chunks to the LLM

## Evaluation Techniques
- Recall@K
- Mean Reciprocal Rank (MRR)
- Manual inspection of retrieved evidence

## Retrieval Risks
- Semantic drift across domains
- Duplicate or overlapping chunks
- Latency increase with high Top-K values
