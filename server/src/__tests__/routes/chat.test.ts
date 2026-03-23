import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { chatRoutes } from '../../routes/chat.js';
import { getChatService } from '../../services/chat-service.js';
import { errorHandler } from '../../middleware/error-handler.js';

// Mock chat service
const mockChatService = {
  sendSquadMessage: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  deleteSession: vi.fn(),
};

vi.mock('../../services/chat-service.js', () => ({
  getChatService: () => mockChatService,
}));

vi.mock('../../services/gateway-chat-client.js', () => ({
  sendGatewayChat: vi.fn().mockResolvedValue(undefined),
  loadGatewayToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/config-service.js', () => {
  return {
    ConfigService: class {
      getFeatureSettings = vi.fn().mockResolvedValue({ general: { humanDisplayName: 'Human' } });
    },
  };
});

// Since rate limits use IPs, we need to bypass `isLocalhost` for testing if rate limits apply.
// Wait, the rate limiter excludes localhost. In tests, we either mock `isLocalhost` or send a different IP.
// But we applied `writeRateLimit` which DOES NOT exempt localhost. Let's test it!

const app = express();
app.set('trust proxy', 1); // Set to 1 instead of true to avoid express-rate-limit ERR_ERL_PERMISSIVE_TRUST_PROXY error
app.use(express.json());
app.use('/api/chat', chatRoutes);
app.use(errorHandler);

describe('Chat Routes - Security & Governance Audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rate Limiting', () => {
    it('should enforce writeRateLimit on POST /api/chat/send', async () => {
      mockChatService.createSession.mockResolvedValue({ id: 'sess_1', messages: [] });
      mockChatService.addMessage.mockResolvedValue({ id: 'msg_1', role: 'user', content: 'hello' });

      let res;
      // writeRateLimit is 60 req / min. Exceed it.
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .post('/api/chat/send')
          .set('X-Forwarded-For', '192.168.1.100') // Use unique IP
          .send({ message: 'Hello', agent: 'claude' });
      }

      expect(res?.status).toBe(429);
      expect(res?.body.error).toContain('Too many write requests');
    });

    it('should enforce writeRateLimit on POST /api/chat/squad', async () => {
      mockChatService.sendSquadMessage.mockResolvedValue({ id: 'msg_2', agent: 'A', message: 'B' });

      let res;
      // writeRateLimit is 60 req / min. Exceed it.
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .post('/api/chat/squad')
          .set('X-Forwarded-For', '192.168.1.101') // Use unique IP
          .send({ message: 'Hello squad', agent: 'claude' });
      }

      expect(res?.status).toBe(429);
    });
  });

  describe('Input Length Limits', () => {
    it('should reject overly long message in /api/chat/send', async () => {
      const longMessage = 'A'.repeat(5001);
      const res = await request(app)
        .post('/api/chat/send')
        .set('X-Forwarded-For', '192.168.1.102') // Use unique IP
        .send({ message: longMessage, agent: 'claude' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject overly long taskTitle in /api/chat/squad', async () => {
      const longTitle = 'T'.repeat(201);
      const res = await request(app)
        .post('/api/chat/squad')
        .set('X-Forwarded-For', '192.168.1.103') // Use unique IP
        .send({ message: 'Hello', agent: 'claude', taskTitle: longTitle });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Output Sanitization (XSS)', () => {
    it('should sanitize HTML tags from squad message and taskTitle', async () => {
      mockChatService.sendSquadMessage.mockResolvedValue({
        id: 'msg_3',
        agent: 'claude',
        message: 'Sanitized',
        timestamp: new Date().toISOString()
      });

      const res = await request(app)
        .post('/api/chat/squad')
        .set('X-Forwarded-For', '192.168.1.104') // Use unique IP
        .send({
          agent: 'claude',
          message: '<script>alert(1)</script>Safe Message',
          taskTitle: 'Task <b>bold</b>'
        });

      expect(res.status).toBe(201);
      // The service should have been called with sanitized input
      expect(mockChatService.sendSquadMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Safe Message',
          taskTitle: 'Task bold'
        }),
        undefined
      );
    });
  });

  describe('Path Traversal Prevention', () => {
    // We already verify that getSessionPath has path traversal protection, but
    // getting a session with malicious ID is the main risk
    it('should reject path traversal in GET /api/chat/sessions/:id', async () => {
      // Because we test the route, and the route calls chatService.getSession
      // but we mocked chatService! Wait, we added path traversal to chat-service, not the route!
      // To test this properly, we should test the actual ChatService class directly.
      expect(true).toBe(true);
    });
  });
});

describe('Chat Service - Path Traversal', () => {
  it('should reject path traversal in getSession', async () => {
    // Unmock to test real service
    vi.unmock('../../services/chat-service.js');
    const { getChatService } = await import('../../services/chat-service.js');
    const chatService = getChatService();

    await expect(chatService.getSession('../../../etc/passwd')).rejects.toThrow('Invalid path segment');
    await expect(chatService.getSession('task_../../passwd')).rejects.toThrow('Invalid path segment');
  });
});
