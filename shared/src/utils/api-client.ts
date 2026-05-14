/**
 * Shared API client for CLI and MCP
 */

import type { Task } from '../types/task.types.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BASE = 'http://localhost:3001';

/** Standard API response envelope */
interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  meta?: Record<string, unknown>;
}

/**
 * Create an API client instance
 * @param baseUrl - Base URL for the API (default: http://localhost:3001)
 * @returns API client function
 */
export function createApiClient(baseUrl = DEFAULT_BASE) {
  const actor = (typeof process !== 'undefined' && process.env?.KANBAN_ACTOR) || 'codex';
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  function base64Url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function ensureSecret(): string {
    const file = join(homedir(), '.secrets', 'kanban-hmac');
    try {
      const existing = readFileSync(file, 'utf8').trim();
      if (/^[a-f0-9]{64}$/i.test(existing)) return existing;
    } catch {
      // generate on first use
    }
    mkdirSync(join(homedir(), '.secrets'), { recursive: true });
    const generated = randomBytes(32).toString('hex');
    writeFileSync(file, `${generated}\n`, { mode: 0o600 });
    return generated;
  }

  return async function api<T>(path: string, options?: RequestInit): Promise<T> {
    const method = (options?.method || 'GET').toUpperCase();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string> | undefined),
    };

    if (writeMethods.has(method)) {
      const secret = ensureSecret();
      const ts = new Date().toISOString();
      const body = typeof options?.body === 'string' ? options.body : '';
      const bodyHash = createHash('sha256').update(body).digest('hex');
      const canonical = `${method}\n${path}\n${ts}\n${bodyHash}`;
      const sig = base64Url(
        createHmac('sha256', Buffer.from(secret, 'hex')).update(canonical).digest()
      );
      headers['X-Kanban-Actor'] = actor;
      headers['X-Kanban-Ts'] = ts;
      headers['X-Kanban-Sig'] = sig;
    }

    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const error = (await res.json().catch(() => ({ error: res.statusText }))) as {
        error?: string;
      };
      throw new Error(error.error || `API error: ${res.status}`);
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
