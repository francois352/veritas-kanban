import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import delegationRoutes from '../../routes/delegation.js';
import { errorHandler } from '../../middleware/error-handler.js';

const mockDelegationService = vi.hoisted(() => ({
  getDelegation: vi.fn(),
  setDelegation: vi.fn(),
  revokeDelegation: vi.fn(),
  canApprove: vi.fn(),
  logApproval: vi.fn(),
  getApprovalLog: vi.fn(),
}));

vi.mock('../../services/delegation-service.js', () => ({
  getDelegationService: () => mockDelegationService,
}));

vi.mock('../../middleware/auth.js', () => ({
  authorize: () => (req: any, res: any, next: any) => next(),
}));

vi.mock('../../services/audit-service.js', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/delegation', delegationRoutes);
app.use(errorHandler);

describe('Delegation Routes - Security & Governance Audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rate Limiting', () => {
    it('should enforce writeRateLimit on POST /api/delegation', async () => {
      mockDelegationService.setDelegation.mockResolvedValue({});

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .post('/api/delegation')
          .set('X-Forwarded-For', '192.168.1.107')
          .send({
            delegateAgent: 'claude',
            expires: new Date(Date.now() + 86400000).toISOString(),
            scope: { type: 'all' },
            createdBy: 'admin'
          });
      }

      expect(res?.status).toBe(429);
      expect(res?.body.error).toContain('Too many write requests');
    });

    it('should enforce writeRateLimit on DELETE /api/delegation', async () => {
      mockDelegationService.revokeDelegation.mockResolvedValue(true);

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .delete('/api/delegation')
          .set('X-Forwarded-For', '192.168.1.108');
      }

      expect(res?.status).toBe(429);
    });
  });

  describe('Input Length Limits', () => {
    it('should reject overly long delegateAgent and createdBy', async () => {
      const longString = 'A'.repeat(101);
      const res = await request(app)
        .post('/api/delegation')
        .send({
          delegateAgent: longString,
          expires: new Date(Date.now() + 86400000).toISOString(),
          scope: { type: 'all' },
          createdBy: longString
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
