import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/error-handler.js';

const mockChatService = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionForTask: vi.fn(),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  sendSquadMessage: vi.fn(),
  getSquadMessages: vi.fn(),
}));

vi.mock('../../services/chat-service.js', () => ({
  getChatService: () => mockChatService,
}));

vi.mock('../../services/gateway-chat-client.js', () => ({
  sendGatewayChat: vi.fn().mockResolvedValue(undefined),
  loadGatewayToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/broadcast-service.js', () => ({
  broadcastChatMessage: vi.fn(),
  broadcastSquadMessage: vi.fn(),
}));

vi.mock('../../services/squad-webhook-service.js', () => ({
  fireSquadWebhook: vi.fn().mockResolvedValue(undefined),
}));

const mockConfigServiceInstance = vi.hoisted(() => ({
  getFeatureSettings: vi.fn().mockResolvedValue({
    general: { humanDisplayName: 'Test User' },
    squadWebhook: 'http://example.com/webhook',
  }),
}));

vi.mock('../../services/config-service.js', () => {
  return {
    ConfigService: class {
      getFeatureSettings = mockConfigServiceInstance.getFeatureSettings;
    },
  };
});

// Import after mocks
import { chatRoutes } from '../../routes/chat.js';

describe('Chat Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
    app.use(errorHandler);
  });

  describe('POST /api/chat/send', () => {
    it('creates a new session if no sessionId is provided', async () => {
      mockChatService.createSession.mockResolvedValue({
        id: 'session_123',
        agent: 'veritas',
        mode: 'ask',
      });
      mockChatService.addMessage.mockResolvedValue({ id: 'msg_1', role: 'user', content: 'hello' });

      const response = await request(app).post('/api/chat/send').send({
        message: 'hello',
        agent: 'veritas',
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        sessionId: 'session_123',
        messageId: 'msg_1',
        message: 'Message sent — agent response incoming',
      });
      expect(mockChatService.createSession).toHaveBeenCalledWith({ agent: 'veritas', mode: 'ask' });
      expect(mockChatService.addMessage).toHaveBeenCalledWith('session_123', {
        role: 'user',
        content: 'hello',
      });
    });

    it('uses existing session if sessionId is provided', async () => {
      mockChatService.getSession.mockResolvedValue({
        id: 'session_123',
        agent: 'veritas',
        mode: 'ask',
      });
      mockChatService.addMessage.mockResolvedValue({ id: 'msg_1', role: 'user', content: 'hello' });

      const response = await request(app).post('/api/chat/send').send({
        sessionId: 'session_123',
        message: 'hello',
      });

      expect(response.status).toBe(200);
      expect(mockChatService.getSession).toHaveBeenCalledWith('session_123');
      expect(mockChatService.addMessage).toHaveBeenCalledWith('session_123', {
        role: 'user',
        content: 'hello',
      });
    });

    it('returns 404 if sessionId is provided but session not found', async () => {
      mockChatService.getSession.mockResolvedValue(null);

      const response = await request(app).post('/api/chat/send').send({
        sessionId: 'session_123',
        message: 'hello',
      });

      expect(response.status).toBe(404);
    });

    it('returns 400 if message is empty', async () => {
      const response = await request(app).post('/api/chat/send').send({
        message: '',
      });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/chat/sessions', () => {
    it('returns all sessions', async () => {
      mockChatService.listSessions.mockResolvedValue([{ id: 'session_1' }, { id: 'session_2' }]);

      const response = await request(app).get('/api/chat/sessions');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(mockChatService.listSessions).toHaveBeenCalled();
    });
  });

  describe('GET /api/chat/sessions/:id', () => {
    it('returns session if found', async () => {
      mockChatService.getSession.mockResolvedValue({ id: 'session_1', messages: [] });

      const response = await request(app).get('/api/chat/sessions/session_1');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('session_1');
    });

    it('returns 404 if session not found', async () => {
      mockChatService.getSession.mockResolvedValue(null);

      const response = await request(app).get('/api/chat/sessions/session_not_found');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/chat/sessions/:id/history', () => {
    it('returns session history if found', async () => {
      mockChatService.getSession.mockResolvedValue({
        id: 'session_1',
        messages: [{ id: 'msg_1' }],
      });

      const response = await request(app).get('/api/chat/sessions/session_1/history');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe('msg_1');
    });

    it('returns 404 if session not found', async () => {
      mockChatService.getSession.mockResolvedValue(null);

      const response = await request(app).get('/api/chat/sessions/session_not_found/history');

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/chat/sessions/:id', () => {
    it('deletes session', async () => {
      mockChatService.deleteSession.mockResolvedValue(true);

      const response = await request(app).delete('/api/chat/sessions/session_1');

      expect(response.status).toBe(204);
      expect(mockChatService.deleteSession).toHaveBeenCalledWith('session_1');
    });
  });

  describe('POST /api/chat/squad', () => {
    it('sends a squad message', async () => {
      mockChatService.sendSquadMessage.mockResolvedValue({
        id: 'msg_1',
        agent: 'Human',
        message: 'hello squad',
      });

      const response = await request(app).post('/api/chat/squad').send({
        agent: 'Human',
        message: 'hello squad',
      });

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('msg_1');
      expect(mockChatService.sendSquadMessage).toHaveBeenCalled();
    });

    it('returns 400 for invalid input', async () => {
      const response = await request(app).post('/api/chat/squad').send({
        agent: 'Human',
        message: '',
      });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/chat/squad', () => {
    it('returns squad messages', async () => {
      mockChatService.getSquadMessages.mockResolvedValue([{ id: 'msg_1' }]);

      const response = await request(app).get('/api/chat/squad?limit=10');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockChatService.getSquadMessages).toHaveBeenCalledWith({
        since: undefined,
        agent: undefined,
        limit: 10,
        includeSystem: true,
      });
    });
  });
});
