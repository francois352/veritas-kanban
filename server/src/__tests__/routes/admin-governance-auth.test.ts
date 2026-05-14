import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPolicyService,
  mockToolPolicyService,
  mockAgentPermissionService,
  mockAgentRoutingService,
  mockTaskService,
} = vi.hoisted(() => ({
  mockPolicyService: {
    listPolicies: vi.fn(),
    createPolicy: vi.fn(),
    updatePolicy: vi.fn(),
    deletePolicy: vi.fn(),
    evaluatePolicies: vi.fn(),
  },
  mockToolPolicyService: {
    listPolicies: vi.fn(),
    getToolPolicy: vi.fn(),
    savePolicy: vi.fn(),
    deletePolicy: vi.fn(),
    validateToolAccess: vi.fn(),
  },
  mockAgentPermissionService: {
    listPermissions: vi.fn(),
    getPendingApprovals: vi.fn(),
    getPermissions: vi.fn(),
    setLevel: vi.fn(),
    updatePermissions: vi.fn(),
    checkPermission: vi.fn(),
    requestApproval: vi.fn(),
    reviewApproval: vi.fn(),
  },
  mockAgentRoutingService: {
    resolveAgent: vi.fn(),
    getRoutingConfig: vi.fn(),
    updateRoutingConfig: vi.fn(),
  },
  mockTaskService: {
    getTask: vi.fn(),
  },
}));

vi.mock('../../config/security.js', () => ({
  getSecurityConfig: vi.fn(() => ({
    authEnabled: false,
    passwordHash: null,
    jwtSecret: 'test-secret-key',
  })),
  getJwtSecret: vi.fn(() => 'test-secret-key'),
  getValidJwtSecrets: vi.fn(() => ['test-secret-key']),
}));

vi.mock('../../services/policy-service.js', () => ({
  getPolicyService: () => mockPolicyService,
}));

vi.mock('../../services/tool-policy-service.js', () => ({
  getToolPolicyService: () => mockToolPolicyService,
}));

vi.mock('../../services/agent-permission-service.js', () => ({
  getAgentPermissionService: () => mockAgentPermissionService,
}));

vi.mock('../../services/agent-routing-service.js', () => ({
  getAgentRoutingService: () => mockAgentRoutingService,
}));

vi.mock('../../services/task-service.js', () => ({
  getTaskService: () => mockTaskService,
}));

import { authenticate, authorizeWrite } from '../../middleware/auth.js';
import policyRoutes from '../../routes/policies.js';
import toolPolicyRoutes from '../../routes/tool-policies.js';
import { agentPermissionRoutes } from '../../routes/agent-permissions.js';
import { agentRoutingRoutes } from '../../routes/agent-routing.js';

const adminKey = 'admin-key-for-governance-route-tests-32chars';
const agentKey = 'agent-key';

const policyBody = {
  id: 'agent-created-policy',
  name: 'Agent Created Policy',
  type: 'rate-limit',
  enabled: true,
  scope: { agents: [], projects: [], actionTypes: [] },
  responseAction: 'warn',
  config: { maxAttempts: 5, windowMs: 60_000, scopeKey: 'agent' },
};

const toolPolicyBody = {
  role: 'intern',
  allowed: ['*'],
  denied: [],
  description: 'Test policy',
};

const routingConfigBody = {
  enabled: true,
  rules: [],
  defaultAgent: 'codex',
  fallbackOnFailure: true,
  maxRetries: 1,
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', authenticate, authorizeWrite);
  app.use('/api/policies', policyRoutes);
  app.use('/api/tool-policies', toolPolicyRoutes);
  app.use('/api/agents/permissions', agentPermissionRoutes);
  app.use('/api/agents', agentRoutingRoutes);
  return app;
}

function expectForbiddenAgent(response: request.Response) {
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({
    code: 'FORBIDDEN',
    message: 'Insufficient permissions',
    details: {
      required: ['admin'],
      current: 'agent',
    },
  });
}

describe('admin-only governance routes', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      VERITAS_AUTH_ENABLED: 'true',
      VERITAS_AUTH_LOCALHOST_BYPASS: 'false',
      VERITAS_ADMIN_KEY: adminKey,
      VERITAS_API_KEYS: `agent:${agentKey}:agent`,
    };

    vi.clearAllMocks();

    mockPolicyService.createPolicy.mockResolvedValue(policyBody);
    mockPolicyService.updatePolicy.mockResolvedValue(policyBody);
    mockPolicyService.deletePolicy.mockResolvedValue(undefined);
    mockPolicyService.evaluatePolicies.mockResolvedValue({ decision: 'allow', matches: [] });

    mockToolPolicyService.getToolPolicy.mockResolvedValue(toolPolicyBody);
    mockToolPolicyService.savePolicy.mockResolvedValue(undefined);
    mockToolPolicyService.deletePolicy.mockResolvedValue(undefined);
    mockToolPolicyService.validateToolAccess.mockResolvedValue(true);

    mockAgentPermissionService.setLevel.mockResolvedValue({ agentId: 'a1', level: 'lead' });
    mockAgentPermissionService.updatePermissions.mockResolvedValue({
      agentId: 'a1',
      canApprove: true,
    });
    mockAgentPermissionService.requestApproval.mockResolvedValue({
      id: 'approval_1',
      agentId: 'a1',
      action: 'create_task',
      status: 'pending',
    });
    mockAgentPermissionService.reviewApproval.mockResolvedValue({
      id: 'approval_1',
      agentId: 'a1',
      action: 'create_task',
      status: 'approved',
    });

    mockAgentRoutingService.resolveAgent.mockResolvedValue({ agent: 'codex' });
    mockAgentRoutingService.updateRoutingConfig.mockResolvedValue(routingConfigBody);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('denies agent keys from policy mutations and allows admin keys', async () => {
    const app = createApp();

    expectForbiddenAgent(
      await request(app).post('/api/policies').set('X-API-Key', agentKey).send(policyBody)
    );
    expectForbiddenAgent(
      await request(app)
        .put('/api/policies/agent-created-policy')
        .set('X-API-Key', agentKey)
        .send(policyBody)
    );
    expectForbiddenAgent(
      await request(app).delete('/api/policies/agent-created-policy').set('X-API-Key', agentKey)
    );
    expect(mockPolicyService.createPolicy).not.toHaveBeenCalled();
    expect(mockPolicyService.updatePolicy).not.toHaveBeenCalled();
    expect(mockPolicyService.deletePolicy).not.toHaveBeenCalled();

    await request(app)
      .post('/api/policies')
      .set('X-API-Key', adminKey)
      .send(policyBody)
      .expect(201);
    expect(mockPolicyService.createPolicy).toHaveBeenCalledWith(policyBody);
  });

  it('keeps policy evaluation available to agent keys', async () => {
    const app = createApp();

    await request(app)
      .post('/api/policies/evaluate')
      .set('X-API-Key', agentKey)
      .send({ actionType: 'create_task', riskScore: 10, preview: false })
      .expect(200);

    expect(mockPolicyService.evaluatePolicies).toHaveBeenCalledWith({
      actionType: 'create_task',
      riskScore: 10,
      preview: false,
    });
  });

  it('denies agent keys from tool policy mutations and validation and allows admin keys', async () => {
    const app = createApp();

    expectForbiddenAgent(
      await request(app).post('/api/tool-policies').set('X-API-Key', agentKey).send(toolPolicyBody)
    );
    expectForbiddenAgent(
      await request(app)
        .put('/api/tool-policies/intern')
        .set('X-API-Key', agentKey)
        .send(toolPolicyBody)
    );
    expectForbiddenAgent(
      await request(app).delete('/api/tool-policies/intern').set('X-API-Key', agentKey)
    );
    expectForbiddenAgent(
      await request(app)
        .post('/api/tool-policies/intern/validate')
        .set('X-API-Key', agentKey)
        .send({ tool: 'exec' })
    );
    expect(mockToolPolicyService.savePolicy).not.toHaveBeenCalled();
    expect(mockToolPolicyService.deletePolicy).not.toHaveBeenCalled();
    expect(mockToolPolicyService.validateToolAccess).not.toHaveBeenCalled();

    await request(app)
      .put('/api/tool-policies/intern')
      .set('X-API-Key', adminKey)
      .send(toolPolicyBody)
      .expect(200);
    expect(mockToolPolicyService.savePolicy).toHaveBeenCalledWith(toolPolicyBody);
  });

  it('denies agent keys from permission elevation and approval review and allows admin keys', async () => {
    const app = createApp();

    expectForbiddenAgent(
      await request(app)
        .put('/api/agents/permissions/a1/level')
        .set('X-API-Key', agentKey)
        .send({ level: 'lead' })
    );
    expectForbiddenAgent(
      await request(app)
        .patch('/api/agents/permissions/a1')
        .set('X-API-Key', agentKey)
        .send({ canApprove: true })
    );
    expectForbiddenAgent(
      await request(app)
        .post('/api/agents/permissions/approvals/approval_1')
        .set('X-API-Key', agentKey)
        .send({ decision: 'approved', reviewedBy: 'a1' })
    );
    expect(mockAgentPermissionService.setLevel).not.toHaveBeenCalled();
    expect(mockAgentPermissionService.updatePermissions).not.toHaveBeenCalled();
    expect(mockAgentPermissionService.reviewApproval).not.toHaveBeenCalled();

    await request(app)
      .put('/api/agents/permissions/a1/level')
      .set('X-API-Key', adminKey)
      .send({ level: 'lead' })
      .expect(200);
    expect(mockAgentPermissionService.setLevel).toHaveBeenCalledWith('a1', 'lead');
  });

  it('keeps approval requests available to agent keys', async () => {
    const app = createApp();

    await request(app)
      .post('/api/agents/permissions/approvals')
      .set('X-API-Key', agentKey)
      .send({ agentId: 'a1', action: 'create_task' })
      .expect(201);

    expect(mockAgentPermissionService.requestApproval).toHaveBeenCalledWith({
      agentId: 'a1',
      action: 'create_task',
    });
  });

  it('denies agent keys from routing config mutation and allows admin keys', async () => {
    const app = createApp();

    expectForbiddenAgent(
      await request(app)
        .put('/api/agents/routing')
        .set('X-API-Key', agentKey)
        .send(routingConfigBody)
    );
    expect(mockAgentRoutingService.updateRoutingConfig).not.toHaveBeenCalled();

    await request(app)
      .put('/api/agents/routing')
      .set('X-API-Key', adminKey)
      .send(routingConfigBody)
      .expect(200);
    expect(mockAgentRoutingService.updateRoutingConfig).toHaveBeenCalledWith(routingConfigBody);
  });

  it('keeps ad-hoc routing resolution available to agent keys', async () => {
    const app = createApp();

    await request(app)
      .post('/api/agents/route')
      .set('X-API-Key', agentKey)
      .send({ type: 'feature', priority: 'medium' })
      .expect(200);

    expect(mockAgentRoutingService.resolveAgent).toHaveBeenCalledWith({
      type: 'feature',
      priority: 'medium',
      project: undefined,
      subtasks: undefined,
    });
  });
});
