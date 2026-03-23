import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/error-handler.js';

const mockDelegationService = vi.hoisted(() => ({
  getDelegation: vi.fn(),
  setDelegation: vi.fn(),
  revokeDelegation: vi.fn(),
  getApprovalLog: vi.fn(),
}));

vi.mock('../../services/delegation-service.js', () => ({
  getDelegationService: () => mockDelegationService,
}));

vi.mock('../../services/audit-service.js', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

// Mock auth middleware to let tests pass without valid tokens
vi.mock('../../middleware/auth.js', () => ({
  authorize: () => (req: any, res: any, next: any) => {
    req.auth = { keyName: 'admin-user' };
    next();
  },
}));

import delegationRoutes from '../../routes/delegation.js';

describe('Delegation Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/delegation', delegationRoutes);
    app.use(errorHandler);
  });

  describe('GET /api/delegation', () => {
    it('returns current delegation settings', async () => {
      mockDelegationService.getDelegation.mockResolvedValue({
        delegateAgent: 'assistant',
        expires: '2025-01-01T00:00:00Z',
      });

      const response = await request(app).get('/api/delegation');

      expect(response.status).toBe(200);
      expect(response.body.delegation.delegateAgent).toBe('assistant');
      expect(mockDelegationService.getDelegation).toHaveBeenCalled();
    });
  });

  describe('POST /api/delegation', () => {
    it('sets delegation settings', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);
      const expires = futureDate.toISOString();

      const scope = { type: 'all' as const };
      mockDelegationService.setDelegation.mockResolvedValue({
        delegateAgent: 'assistant',
        expires,
        scope,
      });

      const response = await request(app).post('/api/delegation').send({
        delegateAgent: 'assistant',
        expires,
        scope,
        createdBy: 'admin-user',
      });

      expect(response.status).toBe(200);
      expect(response.body.delegation.delegateAgent).toBe('assistant');
      expect(mockDelegationService.setDelegation).toHaveBeenCalledWith({
        delegateAgent: 'assistant',
        expires,
        scope,
        excludePriorities: undefined,
        excludeTags: undefined,
        createdBy: 'admin-user',
      });
    });

    it('returns 400 for invalid expiry date', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      const expires = pastDate.toISOString();

      const response = await request(app).post('/api/delegation').send({
        delegateAgent: 'assistant',
        expires,
        scope: { type: 'all' },
        createdBy: 'admin-user',
      });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/delegation', () => {
    it('revokes delegation', async () => {
      mockDelegationService.revokeDelegation.mockResolvedValue(true);

      const response = await request(app).delete('/api/delegation');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockDelegationService.revokeDelegation).toHaveBeenCalled();
    });

    it('returns 404 if no active delegation to revoke', async () => {
      mockDelegationService.revokeDelegation.mockResolvedValue(false);

      const response = await request(app).delete('/api/delegation');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('No active delegation to revoke');
    });
  });

  describe('GET /api/delegation/log', () => {
    it('returns approval log', async () => {
      mockDelegationService.getApprovalLog.mockResolvedValue([
        { id: 'log_1' },
      ]);

      const response = await request(app).get('/api/delegation/log?limit=10');

      expect(response.status).toBe(200);
      expect(response.body.approvals).toHaveLength(1);
      expect(mockDelegationService.getApprovalLog).toHaveBeenCalledWith({
        taskId: undefined,
        agent: undefined,
        limit: 10,
      });
    });
  });
});
