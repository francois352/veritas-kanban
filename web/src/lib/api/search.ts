import { API_BASE, handleResponse } from './helpers';

export type SearchBackend = 'auto' | 'qmd' | 'keyword';
export type SearchCollection = 'tasks-active' | 'tasks-archive' | 'docs';

export interface SearchRequest {
  query: string;
  limit?: number;
  collections?: SearchCollection[];
  backend?: SearchBackend;
  minScore?: number;
}

export interface SearchResult {
  id: string;
  title: string;
  path: string;
  collection: SearchCollection | string;
  snippet: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  backend: 'qmd' | 'keyword';
  degraded: boolean;
  reason?: string;
  elapsedMs: number;
  results: SearchResult[];
}

export const searchApi = {
  query: async (input: SearchRequest): Promise<SearchResponse> => {
    const response = await fetch(`${API_BASE}/search`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return handleResponse<SearchResponse>(response);
  },
};
