/**
 * Shared API client for CLI and MCP
 */

import type { Task } from '../types/task.types.js';

const DEFAULT_BASE = 'http://localhost:3001';

/** Standard API response envelope */
interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  meta?: Record<string, unknown>;
}

export type ApiRequestPreparer = (
  path: string,
  options: RequestInit
) => RequestInit | Promise<RequestInit>;

export interface ApiClientOptions {
  prepareRequest?: ApiRequestPreparer;
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback;

  const record = error as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error;
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === 'string') return nested.message;
  }
  if (typeof record.message === 'string') return record.message;

  return fallback;
}

/**
 * Create an API client instance
 * @param baseUrl - Base URL for the API (default: http://localhost:3001)
 * @param clientOptions - Optional request preparation hook for CLI/MCP concerns
 * @returns API client function
 */
export function createApiClient(baseUrl = DEFAULT_BASE, clientOptions: ApiClientOptions = {}) {
  return async function api<T>(path: string, options?: RequestInit): Promise<T> {
    const requestOptions: RequestInit = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    };

    const preparedOptions = clientOptions.prepareRequest
      ? await clientOptions.prepareRequest(path, requestOptions)
      : requestOptions;

    const res = await fetch(`${baseUrl}${path}`, preparedOptions);

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(extractErrorMessage(error, `API error: ${res.status}`));
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const body = await res.json();

    // Unwrap standard API envelope { success, data, meta }
    if (body && typeof body === 'object' && 'success' in body && 'data' in body) {
      return (body as ApiEnvelope<T>).data;
    }

    return body as T;
  };
}

/**
 * Default API client using environment variable or localhost
 * Uses typeof check to avoid ReferenceError in browser environments
 */
export const API_BASE = (typeof process !== 'undefined' && process.env?.VK_API_URL) || DEFAULT_BASE;
export const api = createApiClient(API_BASE);

/**
 * Find task by ID (supports partial matching on ID suffix)
 * @param id - Full or partial task ID
 * @param apiClient - Optional custom API client (defaults to shared api client)
 * @returns Task if found, null otherwise
 */
export async function findTask(id: string, apiClient = api): Promise<Task | null> {
  const tasks = await apiClient<Task[]>('/api/tasks');
  return tasks.find((t) => t.id === id || t.id.endsWith(id)) || null;
}
