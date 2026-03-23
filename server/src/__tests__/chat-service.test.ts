import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChatService } from '../services/chat-service.js';
import fs from 'fs/promises';

describe('ChatService', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let service: ChatService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'vk-chat-'));
    process.chdir(tempDir);
    service = new ChatService({ chatsDir: join(tempDir, '.veritas-kanban', 'chats') });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Session Management', () => {
    it('creates a new task-scoped session', async () => {
      const session = await service.createSession({ taskId: 'TASK-123', agent: 'test-agent' });
      expect(session.id).toBe('task_TASK-123');
      expect(session.taskId).toBe('TASK-123');
      expect(session.agent).toBe('test-agent');
      expect(session.messages).toEqual([]);

      const retrieved = await service.getSession('task_TASK-123');
      expect(retrieved).toMatchObject(session);
    });

    it('creates a new board-level session', async () => {
      const session = await service.createSession({ agent: 'test-agent' });
      expect(session.id.startsWith('chat_')).toBe(true);
      expect(session.taskId).toBeUndefined();

      const retrieved = await service.getSession(session.id);
      expect(retrieved).toMatchObject(session);
    });

    it('gets session for a task', async () => {
      await service.createSession({ taskId: 'TASK-456', agent: 'test-agent' });
      const session = await service.getSessionForTask('TASK-456');
      expect(session).toBeDefined();
      expect(session?.taskId).toBe('TASK-456');
    });

    it('returns null when getting non-existent session', async () => {
      expect(await service.getSession('task_NON-EXISTENT')).toBeNull();
      expect(await service.getSession('chat_NON-EXISTENT')).toBeNull();
      expect(await service.getSessionForTask('NON-EXISTENT')).toBeNull();
    });

    it('lists board-level sessions', async () => {
      await service.createSession({ agent: 'agent1' });
      await service.createSession({ agent: 'agent2' });
      // Task sessions shouldn't be listed
      await service.createSession({ taskId: 'TASK-1', agent: 'agent3' });

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(2);
      expect(sessions.every(s => s.id.startsWith('chat_'))).toBe(true);
    });

    it('deletes a session', async () => {
      const session = await service.createSession({ agent: 'test-agent' });
      await service.deleteSession(session.id);
      expect(await service.getSession(session.id)).toBeNull();
    });

    it('does not throw when deleting non-existent session', async () => {
      await expect(service.deleteSession('chat_NON-EXISTENT')).resolves.toBeUndefined();
    });

    it('adds a message to a session', async () => {
      const session = await service.createSession({ agent: 'test-agent' });
      const message = await service.addMessage(session.id, {
        role: 'user',
        content: 'Hello, world!',
      });

      expect(message.id).toBeDefined();
      expect(message.content).toBe('Hello, world!');

      const retrieved = await service.getSession(session.id);
      expect(retrieved?.messages.length).toBe(1);
      expect(retrieved?.messages[0].id).toBe(message.id);
      expect(retrieved?.messages[0].content).toBe('Hello, world!');
    });

    it('throws when adding message to non-existent session', async () => {
      await expect(
        service.addMessage('chat_NON-EXISTENT', { role: 'user', content: 'test' })
      ).rejects.toThrow();
    });

    it('handles concurrent message additions safely', async () => {
      const session = await service.createSession({ agent: 'test-agent' });

      const promises = Array.from({ length: 10 }).map((_, i) =>
        service.addMessage(session.id, { role: 'user', content: `Message ${i}` })
      );

      await Promise.all(promises);

      const retrieved = await service.getSession(session.id);
      expect(retrieved?.messages.length).toBe(10);

      // Check that all 10 messages are present, though order may vary
      const contents = retrieved?.messages.map(m => m.content);
      for (let i = 0; i < 10; i++) {
        expect(contents).toContain(`Message ${i}`);
      }
    });
  });

  describe('Squad Messaging', () => {
    let squadDir: string;
    beforeEach(async () => {
      // Create a unique squad directory for each test
      const testId = Math.random().toString(36).substring(7);
      squadDir = join(tempDir, '.veritas-kanban', `chats_${testId}`, 'squad');
      // Re-initialize service with the new chats dir
      service = new ChatService({ chatsDir: join(tempDir, '.veritas-kanban', `chats_${testId}`) });

      // Explicitly wait to ensure directories are created before testing squad functionality
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    afterEach(async () => {
      // Small delay to ensure any lingering file handles are closed
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    it('sends and retrieves a squad message', async () => {
      await service.sendSquadMessage({
        agent: 'agent-1',
        message: 'Hello squad',
        tags: ['test'],
        event: 'agent.spawned',
      }, 'Agent One');

      await new Promise(resolve => setTimeout(resolve, 50));

      const messages = await service.getSquadMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].agent).toBe('agent-1');
      expect(messages[0].message).toBe('Hello squad');
      expect(messages[0].displayName).toBe('Agent One');
      expect(messages[0].tags).toEqual(['test']);
      expect(messages[0].event).toBe('agent.spawned');
    });

    it('filters squad messages by agent', async () => {
      await service.sendSquadMessage({ agent: 'agent-1', message: 'msg1' });
      await service.sendSquadMessage({ agent: 'agent-2', message: 'msg2' });

      await new Promise(resolve => setTimeout(resolve, 50));

      const messages = await service.getSquadMessages({ agent: 'agent-1' });
      expect(messages.length).toBe(1);
      expect(messages[0].agent).toBe('agent-1');
    });

    it('filters squad messages by system flag', async () => {
      await service.sendSquadMessage({ agent: 'agent-1', message: 'msg1', system: true });
      await service.sendSquadMessage({ agent: 'agent-2', message: 'msg2' });

      await new Promise(resolve => setTimeout(resolve, 50));

      const messagesNoSystem = await service.getSquadMessages({ includeSystem: false });
      expect(messagesNoSystem.length).toBe(1);
      expect(messagesNoSystem[0].agent).toBe('agent-2');

      const messagesWithSystem = await service.getSquadMessages({ includeSystem: true });
      expect(messagesWithSystem.length).toBe(2);
    });

    it('filters squad messages by since timestamp', async () => {
      const msg1 = await service.sendSquadMessage({ agent: 'agent-1', message: 'msg1' });
      // Artificial delay to ensure timestamps are different if needed,
      // but since we're generating new timestamps each time, we can just use the returned one
      const sinceDate = new Date(new Date(msg1.timestamp).getTime() + 1).toISOString();
      const msg2 = await service.sendSquadMessage({ agent: 'agent-2', message: 'msg2' });

      await new Promise(resolve => setTimeout(resolve, 50));

      const messages = await service.getSquadMessages({ since: sinceDate });
      expect(messages.length).toBe(1);
      expect(messages[0].id).toBe(msg2.id);
    });

    it('respects limit on squad messages', async () => {
      await service.sendSquadMessage({ agent: 'agent-1', message: 'msg1' });
      await service.sendSquadMessage({ agent: 'agent-2', message: 'msg2' });
      await service.sendSquadMessage({ agent: 'agent-3', message: 'msg3' });

      await new Promise(resolve => setTimeout(resolve, 50));

      const messages = await service.getSquadMessages({ limit: 2 });
      expect(messages.length).toBe(2);
      expect(messages[1].message).toBe('msg3'); // Newest ones should be returned (actually oldest are returned first, but it limits to the most recent ones)
    });

    it('handles concurrent squad messages', async () => {
      const promises = Array.from({ length: 10 }).map((_, i) =>
        service.sendSquadMessage({ agent: `agent-${i}`, message: `msg-${i}` })
      );

      await Promise.all(promises);

      // wait a bit for file IO to fully resolve
      await new Promise(resolve => setTimeout(resolve, 50));

      const messages = await service.getSquadMessages();
      expect(messages.length).toBe(10);
    });

    it('returns empty array when no squad messages exist', async () => {
      const messages = await service.getSquadMessages();
      expect(messages).toEqual([]);
    });
  });
});
