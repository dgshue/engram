# Embedding Architecture

## Overview

Engram uses **multi-model ensemble embedding** for semantic search. The embedding backend differs between self-hosted and cloud (SaaS) deployments.

Search quality is further improved by an optional **cross-encoder reranking pipeline** that runs after initial vector retrieval.

## Self-Hosted: Local Ensemble (engram-embed)

- **Service:** [engram-embed](https://github.com/heybeaux/engram-embed) (Rust, Axum, Candle)
- **Port:** 8080
- **Models (4, all on Metal GPU):**
  - `bge-base-en-v1.5` (768-dim)
  - `all-MiniLM-L6-v2` (384-dim)
  - `gte-base-en-v1.5` (768-dim)
  - `nomic-embed-text-v1.5` (768-dim)
- **Config:** `EMBEDDING_PROVIDER=local` (default)
- **Cost:** Zero (runs locally on Apple Silicon)
- **Latency:** ~50ms per embedding (all 4 models in parallel)

## Cloud / SaaS: Cloud Ensemble (OpenAI + Cohere)

- **Service:** Built-in `CloudEnsembleService` (`src/embedding/cloud-ensemble.service.ts`)
- **Models (up to 3):**
  - `openai-small` — OpenAI `text-embedding-3-small` (1536-dim)
  - `openai-large` — OpenAI `text-embedding-3-large` (3072-dim)
  - `cohere-v3` — Cohere Embed v3 (1024-dim)
- **Config:** `EMBEDDING_PROVIDER=cloud-ensemble`
- **Required env vars:**
  - `OPENAI_API_KEY` (required — enables both OpenAI models)
  - `COHERE_API_KEY` (optional — enables Cohere model)
- **Cost:** Per-token pricing from OpenAI/Cohere
- **Latency:** ~200-500ms per embedding (all models in parallel)
- **Note:** Cohere requests are chunked at **96 texts maximum** per API call to stay within provider limits.

## Why Different Models Per Environment?

| Concern | Self-Hosted | Cloud (SaaS) |
|---------|------------|---------------|
| Cost | Zero (local GPU) | Per-token API costs |
| Privacy | All data stays local | Data sent to OpenAI/Cohere |
| Setup | Requires Apple Silicon + Rust build | Just API keys |
| Quality | Research models, excellent for general use | Industry-leading models, best recall |
| Scaling | Limited by local hardware | Scales with API rate limits |

Self-hosted users get free, private embeddings via engram-embed on their own hardware. SaaS users get the highest-quality commercial models without any infrastructure setup.

## Configuration

### Railway (Production SaaS)

Set these environment variables on the Railway service:

```
EMBEDDING_PROVIDER=cloud-ensemble
OPENAI_API_KEY=sk-...
COHERE_API_KEY=...          # optional but recommended
```

### Local Development

engram-embed starts automatically via LaunchAgent `ai.engram.embed`:

```
EMBEDDING_PROVIDER=local
ENGRAM_EMBED_URL=http://localhost:8080
EMBED_DEVICE=metal
```

### Fallback Behavior

If `EMBEDDING_PROVIDER=cloud-ensemble` is set but the API keys are missing:
- Missing `OPENAI_API_KEY`: No cloud models available (warning logged)
- Missing `COHERE_API_KEY`: Only OpenAI models active (2 of 3)

If `EMBEDDING_PROVIDER=local` but engram-embed is unreachable:
- Health endpoint reports `engramEmbed: down`
- Semantic search returns errors until the service is restored
- Memory creation still works (embeddings queued or skipped)

## Ensemble Search

Both backends produce multiple embeddings per memory. At query time, Engram's ensemble search:

1. Generates query embeddings with all available models
2. Runs parallel pgvector similarity searches per model
   - Per-model queries are **isolated** to prevent RLS transaction abort propagation (25P02)
3. Fuses results using **Reciprocal Rank Fusion (RRF)**
4. Optionally re-ranks via cross-encoder (see below)
5. Returns a single ranked result set

This multi-model approach improves recall by ~15-20% over single-model search, as different models capture different semantic aspects of the text.

## Cross-Encoder Reranking Pipeline

After RRF fusion, results can be re-ranked by a cross-encoder model for higher precision.

- **Service:** Text Embeddings Inference (TEI) rerank API
- **Config:** `RERANK_ENABLED=true`, `RERANK_URL=http://localhost:8081`
- **Multi-model ensemble:** Set `RERANK_URLS=url1,url2,...` to run multiple rerankers; results are combined via RRF with configurable weights (`RERANK_MODEL_WEIGHTS`)
- **Fallback:** If the reranker is unavailable, the pipeline gracefully falls back to the RRF-fused order (no error surfaced to the caller)
- **Timeout:** 10 seconds (generous allowance for CPU-based rerankers on shared infrastructure)

### Reranker Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RERANK_ENABLED` | `false` | Enable cross-encoder reranking |
| `RERANK_URL` | `http://localhost:8081` | Single TEI rerank endpoint |
| `RERANK_URLS` | _(empty)_ | Comma-separated list for multi-model ensemble (overrides `RERANK_URL`) |
| `RERANK_MODEL_WEIGHTS` | _(equal weights)_ | Comma-separated floats matching `RERANK_URLS` count |

## Hybrid Search (BM25 + Vector)

As of the P@5 recall improvements (PR #138), the retrieval pipeline supports **BM25 hybrid scoring**:

- BM25 lexical scores are computed alongside vector similarity
- Combined with vector scores before RRF fusion
- Particularly improves recall on exact-match queries and rare terms

Configure via `HYBRID_SEARCH_ENABLED=true` (defaults to `false`).

## P@5 Recall Improvements (2026-03)

Several improvements shipped together (PR #138):

| Change | Impact |
|--------|--------|
| Cross-encoder reranking pipeline | Higher precision on top-5 results |
| BM25 hybrid search | Better recall on lexical queries |
| Sentiment polarity scoring | Distinguishes positive/negative memories |
| Importance score fix | Corrects weighting of high-importance memories |

Measured improvement: ~12% P@5 on the internal recall eval suite.

## Key Files

- `src/embedding/cloud-ensemble.service.ts` — Cloud provider orchestration
- `src/embedding/rerank.service.ts` — Cross-encoder reranking (single + ensemble)
- `src/embedding/openai-embed.provider.ts` — OpenAI embedding provider
- `src/embedding/providers/` — Provider implementations
- `src/embedding/embedding-provider.interface.ts` — Common interface
- `src/ensemble/` — Ensemble search, RRF fusion, drift detection
- `src/vector/providers/pgvector.provider.ts` — pgvector backend (BM25 hybrid)

---

*Last updated: 2026-03-12. Update this doc when embedding providers, models, or the reranking pipeline change.*
