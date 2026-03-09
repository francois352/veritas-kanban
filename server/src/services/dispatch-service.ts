/**
 * Dispatch Service - Bridges Veritas Kanban to the AI Team Redis Streams protocol.
 *
 * When a task is created or reassigned to an AI agent, this service publishes
 * a kanban_dispatch message to the bot:messages Redis stream. Agents pick up
 * these messages via their coordination layer consumer groups.
 *
 * Protocol: ai-team-protocol-v1 (same as shared/coordination.js)
 */

import { createClient, type RedisClientType } from 'redis';
import { randomUUID } from 'crypto';
import { createLogger } from '../lib/logger.js';
import { getAgentRegistryService } from './agent-registry-service.js';

const log = createLogger('dispatch');

const PROTOCOL_VERSION = 'ai-team-protocol-v1';
const STREAM_KEY = 'bot:messages';
const MAX_STREAM_LEN = 1000;

let redis: RedisClientType | null = null;
let connected = false;

/**
 * Initialize Redis connection for dispatch.
 * Called once at server startup. Non-blocking - dispatch is best-effort.
 */
export async function initDispatch(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    log.warn('REDIS_URL not set - dispatch disabled');
    return;
  }

  try {
    redis = createClient({ url }) as RedisClientType;
    redis.on('error', (err: Error) => log.warn('Redis error: ' + err.message));
    redis.on('connect', () => {
      connected = true;
      log.info('Redis dispatch connected');
    });
    redis.on('end', () => {
      connected = false;
    });
    await redis.connect();
  } catch (err) {
    log.warn('Redis init failed - dispatch disabled: ' + (err as Error).message);
    redis = null;
  }
}

/**
 * Check if an agent ID is a registered AI agent (not a human like "francois").
 */
function isAiAgent(agentId: string): boolean {
  const HUMANS = ['francois', 'admin', 'unknown'];
  if (HUMANS.includes(agentId)) return false;

  const registry = getAgentRegistryService();
  const agent = registry.get(agentId);
  return !!agent;
}

/**
 * Dispatch a task to an agent via Redis Streams.
 * Fire-and-forget - never blocks or fails the API call.
 */
export function dispatchToAgent({
  taskId,
  title,
  description,
  assignee,
  priority,
  project,
  constraints,
  origin,
}: {
  taskId: string;
  title: string;
  description?: string;
  assignee: string;
  priority?: string;
  project?: string;
  constraints?: string[];
  origin?: string;
}): void {
  if (!redis || !connected) return;
  if (!assignee || !isAiAgent(assignee)) return;
  if (origin === 'agent') return;

  const msg: Record<string, string> = {
    protocol: PROTOCOL_VERSION,
    id: randomUUID(),
    interactionId: randomUUID(),
    traceId: randomUUID(),
    performative: 'REQUEST',
    from: 'kanban',
    to: assignee,
    type: 'kanban_dispatch',
    payload: JSON.stringify({
      taskId,
      title,
      description: description || '',
      priority: priority || 'medium',
      project: project || '',
      constraints: constraints || [],
    }),
    replyTo: '',
    timestamp: Date.now().toString(),
  };

  redis
    .xAdd(STREAM_KEY, '*', msg, {
      TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: MAX_STREAM_LEN },
    })
    .then(() => log.info(`Dispatched ${taskId} to ${assignee}`))
    .catch((err: Error) => log.warn(`Dispatch failed: ${err.message}`));
}

/**
 * Clean shutdown.
 */
export async function stopDispatch(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => {});
    redis = null;
    connected = false;
  }
}
