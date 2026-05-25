import { requestUrl } from 'obsidian';
import type { MultimodalInput } from '../../core/Embedder';
import type { RerankDocument, RerankResult } from '../../core/Reranker';

export function estimateDashScopeTokens(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    count += code > 0x7f ? 2 : 1;
  }
  return Math.ceil(count / 3);
}

interface DashScopeMultimodalEmbeddingResponse {
  output: {
    embeddings: Array<{
      index: number;
      embedding: number[];
      type: string;
    }>;
  };
  usage: {
    total_tokens?: number;
    image_count?: number;
  };
}

interface DashScopeRerankResponse {
  output: {
    results: Array<{
      index: number;
      relevance_score: number;
      document?: { text: string };
    }>;
  };
  usage: {
    total_tokens: number;
  };
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

export async function dashscopeEmbedding(
  baseUrl: string,
  apiKey: string,
  model: string,
  inputs: MultimodalInput[],
  dimension?: number
): Promise<number[][]> {
  const contents = inputs.map(input => {
    const item: Record<string, string> = {};
    if (input.text !== undefined) item.text = input.text;
    if (input.image !== undefined) item.image = input.image;
    return item;
  });

  const parameters: Record<string, number> = {};
  if (dimension !== undefined) parameters.dimension = dimension;

  const response = await requestUrl({
    url: `${baseUrl}/services/embeddings/multimodal-embedding/multimodal-embedding`,
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model,
      input: { contents },
      parameters,
    }),
  });

  if (response.status !== 200) {
    throw new Error(
      `DashScope embedding failed: ${response.status} ${response.text}`
    );
  }

  const data = response.json as DashScopeMultimodalEmbeddingResponse;
  return data.output.embeddings
    .sort((a, b) => a.index - b.index)
    .map(e => e.embedding);
}

export async function dashscopeRerank(
  baseUrl: string,
  apiKey: string,
  model: string,
  query: string,
  documents: string[],
  topN?: number
): Promise<RerankResult[]> {
  const parameters: Record<string, unknown> = {};
  if (topN !== undefined) parameters.top_n = topN;

  const response = await requestUrl({
    url: `${baseUrl}/services/rerank/text-rerank/text-rerank`,
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model,
      input: { query, documents },
      parameters,
    }),
  });

  if (response.status !== 200) {
    throw new Error(
      `DashScope rerank failed: ${response.status} ${response.text}`
    );
  }

  const data = response.json as DashScopeRerankResponse;
  return data.output.results.map(r => ({
    index: r.index,
    relevanceScore: r.relevance_score,
  }));
}

export async function dashscopeMultimodalRerank(
  baseUrl: string,
  apiKey: string,
  model: string,
  query: RerankDocument,
  documents: RerankDocument[],
  topN?: number
): Promise<RerankResult[]> {
  const parameters: Record<string, unknown> = {};
  if (topN !== undefined) parameters.top_n = topN;

  const response = await requestUrl({
    url: `${baseUrl}/services/rerank/text-rerank/text-rerank`,
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model,
      input: { query, documents },
      parameters,
    }),
  });

  if (response.status !== 200) {
    throw new Error(
      `DashScope multimodal rerank failed: ${response.status} ${response.text}`
    );
  }

  const data = response.json as DashScopeRerankResponse;
  return data.output.results.map(r => ({
    index: r.index,
    relevanceScore: r.relevance_score,
  }));
}
