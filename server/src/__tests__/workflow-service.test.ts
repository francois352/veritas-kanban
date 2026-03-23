import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkflowService, getWorkflowService } from '../services/workflow-service.js';
import type { WorkflowDefinition, WorkflowACL } from '../types/workflow.js';

describe('WorkflowService', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let service: WorkflowService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'vk-workflow-'));
    process.env.DATA_DIR = tempDir;
    // getWorkflowService() is a singleton, so we need to instantiate a new WorkflowService
    // to pick up the new workflows directory in the temp dir.
    service = new WorkflowService();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const validWorkflow: WorkflowDefinition = {
    id: 'test-workflow',
    name: 'Test Workflow',
    version: '1.0',
    description: 'A test workflow',
    agents: [{ id: 'agent-1', name: 'Agent 1', model: 'gpt-4o' }],
    steps: [
      { id: 'step-1', type: 'agent', agent: 'agent-1', instruction: 'Do something' },
    ],
  };

  describe('saveWorkflow', () => {
    it('saves a valid workflow to disk and caches it', async () => {
      await service.saveWorkflow(validWorkflow);

      const loaded = await service.loadWorkflow('test-workflow');
      expect(loaded).toEqual(validWorkflow);

      const cached = (service as any).cache.get('test-workflow');
      expect(cached).toEqual(validWorkflow);

      // Verify file exists
      const fileContent = await readFile(join(tempDir, '.veritas-kanban', 'workflows', 'test-workflow.yml'), 'utf-8');
      expect(fileContent).toContain('id: test-workflow');
    });

    it('updates an existing workflow', async () => {
      await service.saveWorkflow(validWorkflow);

      const updatedWorkflow = { ...validWorkflow, name: 'Updated Name' };
      await service.saveWorkflow(updatedWorkflow);

      const loaded = await service.loadWorkflow('test-workflow');
      expect(loaded?.name).toBe('Updated Name');
    });

    it('enforces maximum workflow limit', async () => {
      // Instead of mocking fs, we can just create dummy files to trigger the condition
      const dir = join(tempDir, '.veritas-kanban', 'workflows');
      await mkdir(dir, { recursive: true });
      for (let i = 0; i < 200; i++) {
        await writeFile(join(dir, `workflow-${i}.yml`), '');
      }

      const promise = service.saveWorkflow(validWorkflow);
      await expect(promise).rejects.toThrow(/Maximum workflow limit \(200\) reached/);
    });

    it('validates missing required fields', async () => {
      const invalid = { ...validWorkflow } as any;
      delete invalid.id;
      await expect(service.saveWorkflow(invalid)).rejects.toThrow(/Workflow must have id, name, and version/);
    });

    it('validates workflow ID format', async () => {
      const invalid = { ...validWorkflow, id: 'invalid/id' };
      await expect(service.saveWorkflow(invalid)).rejects.toThrow(/illegal path characters/);
    });

    it('validates maximum agents', async () => {
      const invalid = { ...validWorkflow, agents: Array.from({ length: 21 }, (_, i) => ({ id: `agent-${i}`, name: 'A', model: 'M' })) };
      await expect(service.saveWorkflow(invalid)).rejects.toThrow(/exceeds maximum of 20 agents/);
    });

    it('validates duplicate agent IDs', async () => {
      const invalid = { ...validWorkflow, agents: [{ id: 'a1', name: 'A', model: 'M' }, { id: 'a1', name: 'B', model: 'M' }] };
      await expect(service.saveWorkflow(invalid)).rejects.toThrow(/Duplicate agent IDs found/);
    });

    it('validates step agent reference', async () => {
      const invalid = { ...validWorkflow, steps: [{ id: 's1', type: 'agent' as const, agent: 'unknown-agent', instruction: 'Do' }] };
      await expect(service.saveWorkflow(invalid)).rejects.toThrow(/references unknown agent/);
    });

    it('validates retry_delay_ms bounds', async () => {
      const invalid = { ...validWorkflow, steps: [{ id: 's1', type: 'agent' as const, agent: 'agent-1', instruction: 'Do', on_fail: { retry: 1, retry_delay_ms: 400000 } }] };
      await expect(service.saveWorkflow(invalid)).rejects.toThrow(/exceeds maximum of 300000ms/);
    });
  });

  describe('loadWorkflow', () => {
    it('returns null for non-existent workflow', async () => {
      const result = await service.loadWorkflow('non-existent');
      expect(result).toBeNull();
    });

    it('throws ValidationError for invalid YAML', async () => {
      const dir = join(tempDir, '.veritas-kanban', 'workflows');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'invalid.yml'), 'invalid: [yaml:');

      await expect(service.loadWorkflow('invalid')).rejects.toThrow(/Invalid workflow YAML/);
    });
  });

  describe('listWorkflows', () => {
    it('lists all valid workflows', async () => {
      await service.saveWorkflow(validWorkflow);
      await service.saveWorkflow({ ...validWorkflow, id: 'test-workflow-2' });

      const workflows = await service.listWorkflows();
      expect(workflows).toHaveLength(2);
      expect(workflows.map(w => w.id)).toContain('test-workflow');
      expect(workflows.map(w => w.id)).toContain('test-workflow-2');
    });
  });

  describe('listWorkflowsMetadata', () => {
    it('lists metadata for all valid workflows', async () => {
      await service.saveWorkflow(validWorkflow);
      await service.saveWorkflow({ ...validWorkflow, id: 'test-workflow-2', description: 'desc 2' });

      const metadata = await service.listWorkflowsMetadata();
      expect(metadata).toHaveLength(2);
      expect(metadata.find(m => m.id === 'test-workflow')).toMatchObject({ id: 'test-workflow', name: 'Test Workflow', version: '1.0' });
      expect(metadata.find(m => m.id === 'test-workflow-2')?.description).toBe('desc 2');
    });
  });

  describe('deleteWorkflow', () => {
    it('deletes workflow and removes from cache', async () => {
      await service.saveWorkflow(validWorkflow);
      await service.deleteWorkflow('test-workflow');

      const loaded = await service.loadWorkflow('test-workflow');
      expect(loaded).toBeNull();

      const cached = (service as any).cache.get('test-workflow');
      expect(cached).toBeUndefined();
    });
  });

  describe('ACL management', () => {
    const acl: WorkflowACL = { workflowId: 'test-workflow', groups: ['admin'], users: ['user1'] };

    beforeEach(async () => {
      await mkdir(join(tempDir, '.veritas-kanban', 'workflows'), { recursive: true });
    });

    it('returns null if no ACLs exist', async () => {
      const result = await service.loadACL('test-workflow');
      expect(result).toBeNull();
    });

    it('saves and loads ACL', async () => {
      await service.saveACL(acl);
      const loaded = await service.loadACL('test-workflow');
      expect(loaded).toEqual(acl);
    });
  });

  describe('auditChange', () => {
    beforeEach(async () => {
      await mkdir(join(tempDir, '.veritas-kanban', 'workflows'), { recursive: true });
    });

    it('appends audit event to log', async () => {
      const event = { type: 'workflow_created' as const, workflowId: 'test-workflow', timestamp: new Date().toISOString(), userId: 'user1' };
      await service.auditChange(event);

      const logContent = await readFile(join(tempDir, '.veritas-kanban', 'workflows', '.audit.jsonl'), 'utf-8');
      expect(logContent).toContain('workflow_created');
      expect(logContent).toContain('test-workflow');
    });
  });
});
