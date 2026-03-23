import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DecisionService } from '../../services/decision-service.js';

describe('DecisionService', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let service: DecisionService;

  beforeEach(async () => {
    // Isolate tests with temp directory
    tempDir = await mkdtemp(join(tmpdir(), 'vk-decisions-'));
    process.chdir(tempDir);
    process.env.DATA_DIR = '.';
    service = new DecisionService();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  describe('create', () => {
    it('creates a new decision', async () => {
      const decision = await service.create({
        inputContext: 'Should we refactor?',
        outputAction: 'Yes, proceed',
        confidenceLevel: 0.9,
        riskScore: 0.2,
      });

      expect(decision.id).toMatch(/^decision_\d+_[a-zA-Z0-9_-]{6}$/);
      expect(decision.inputContext).toBe('Should we refactor?');
      expect(decision.outputAction).toBe('Yes, proceed');
      expect(decision.confidenceLevel).toBe(0.9);
      expect(decision.riskScore).toBe(0.2);
      expect(decision.assumptions).toEqual([]);
      expect(decision.timestamp).toBeDefined();
    });

    it('creates a decision with assumptions', async () => {
      const decision = await service.create({
        inputContext: 'Context',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
        assumptions: [
          'Assumption 1 as string',
          { text: 'Assumption 2 as object' }
        ]
      });

      expect(decision.assumptions).toHaveLength(2);
      expect(decision.assumptions[0]?.text).toBe('Assumption 1 as string');
      expect(decision.assumptions[0]?.status).toBe('pending');
      expect(decision.assumptions[1]?.text).toBe('Assumption 2 as object');
      expect(decision.assumptions[1]?.status).toBe('pending');
    });

    it('throws error if parent decision does not exist', async () => {
      await expect(service.create({
        inputContext: 'Context',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
        parentDecisionId: 'missing-parent'
      })).rejects.toThrow('Parent decision not found: missing-parent');
    });
  });

  describe('list', () => {
    it('returns empty array when no decisions exist', async () => {
      const list = await service.list();
      expect(list).toEqual([]);
    });

    it('returns all decisions ordered by timestamp descending', async () => {
      await service.create({
        inputContext: 'First',
        outputAction: 'Action 1',
        confidenceLevel: 0.5,
        riskScore: 0.5,
        timestamp: '2023-01-01T00:00:00.000Z'
      });

      await service.create({
        inputContext: 'Second',
        outputAction: 'Action 2',
        confidenceLevel: 0.5,
        riskScore: 0.5,
        timestamp: '2023-01-02T00:00:00.000Z'
      });

      const list = await service.list();
      expect(list).toHaveLength(2);
      expect(list[0]?.inputContext).toBe('Second');
      expect(list[1]?.inputContext).toBe('First');
    });

    it('filters decisions by agentId', async () => {
      await service.create({ inputContext: '1', outputAction: '1', confidenceLevel: 0.5, riskScore: 0.5, agentId: 'agentA' });
      await service.create({ inputContext: '2', outputAction: '2', confidenceLevel: 0.5, riskScore: 0.5, agentId: 'agentB' });

      const list = await service.list({ agent: 'agentA' });
      expect(list).toHaveLength(1);
      expect(list[0]?.agentId).toBe('agentA');
    });

    it('filters decisions by time range', async () => {
      await service.create({ inputContext: '1', outputAction: '1', confidenceLevel: 0.5, riskScore: 0.5, timestamp: '2023-01-01T00:00:00.000Z' });
      await service.create({ inputContext: '2', outputAction: '2', confidenceLevel: 0.5, riskScore: 0.5, timestamp: '2023-01-02T00:00:00.000Z' });
      await service.create({ inputContext: '3', outputAction: '3', confidenceLevel: 0.5, riskScore: 0.5, timestamp: '2023-01-03T00:00:00.000Z' });

      const list = await service.list({
        startTime: '2023-01-02T00:00:00.000Z',
        endTime: '2023-01-02T23:59:59.000Z'
      });

      expect(list).toHaveLength(1);
      expect(list[0]?.inputContext).toBe('2');
    });

    it('filters decisions by confidence level', async () => {
      await service.create({ inputContext: '1', outputAction: '1', confidenceLevel: 0.2, riskScore: 0.5 });
      await service.create({ inputContext: '2', outputAction: '2', confidenceLevel: 0.6, riskScore: 0.5 });
      await service.create({ inputContext: '3', outputAction: '3', confidenceLevel: 0.9, riskScore: 0.5 });

      const listMin = await service.list({ minConfidence: 0.5 });
      expect(listMin).toHaveLength(2);
      expect(listMin.map(d => d.confidenceLevel)).toContain(0.6);
      expect(listMin.map(d => d.confidenceLevel)).toContain(0.9);

      const listMax = await service.list({ maxConfidence: 0.5 });
      expect(listMax).toHaveLength(1);
      expect(listMax[0]?.confidenceLevel).toBe(0.2);
    });

    it('filters decisions by risk score', async () => {
      await service.create({ inputContext: '1', outputAction: '1', confidenceLevel: 0.5, riskScore: 0.2 });
      await service.create({ inputContext: '2', outputAction: '2', confidenceLevel: 0.5, riskScore: 0.6 });
      await service.create({ inputContext: '3', outputAction: '3', confidenceLevel: 0.5, riskScore: 0.9 });

      const listMin = await service.list({ minRisk: 0.5 });
      expect(listMin).toHaveLength(2);
      expect(listMin.map(d => d.riskScore)).toContain(0.6);
      expect(listMin.map(d => d.riskScore)).toContain(0.9);

      const listMax = await service.list({ maxRisk: 0.5 });
      expect(listMax).toHaveLength(1);
      expect(listMax[0]?.riskScore).toBe(0.2);
    });
  });

  describe('getById', () => {
    it('returns null if decision not found', async () => {
      const result = await service.getById('missing-id');
      expect(result).toBeNull();
    });

    it('returns decision if found', async () => {
      const decision = await service.create({
        inputContext: 'Test',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
      });

      const found = await service.getById(decision.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(decision.id);
    });
  });

  describe('getChain', () => {
    it('returns single decision if no parent', async () => {
      const decision = await service.create({
        inputContext: 'Test',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
      });

      const chain = await service.getChain(decision.id);
      expect(chain).toHaveLength(1);
      expect(chain[0]?.id).toBe(decision.id);
    });

    it('returns multiple decisions in chain', async () => {
      const root = await service.create({
        inputContext: 'Root',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
      });

      const child = await service.create({
        inputContext: 'Child',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
        parentDecisionId: root.id,
      });

      const grandchild = await service.create({
        inputContext: 'Grandchild',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
        parentDecisionId: child.id,
      });

      const chain = await service.getChain(grandchild.id);
      expect(chain).toHaveLength(3);
      expect(chain[0]?.id).toBe(root.id);
      expect(chain[1]?.id).toBe(child.id);
      expect(chain[2]?.id).toBe(grandchild.id);
    });

    it('handles missing parent gracefully', async () => {
      // Create root
      const root = await service.create({
        inputContext: 'Root',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
      });

      // We manually create a broken link child since create() checks for valid parent
      const fs = await import('fs/promises');
      const childId = 'decision_999_test';
      const childData = {
        id: childId,
        inputContext: 'Child',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
        parentDecisionId: 'non-existent-parent',
        timestamp: new Date().toISOString(),
        assumptions: []
      };

      // getDecisionsDir resolves to path.join(getStorageRoot(), 'storage', 'decisions');
      const decisionsDir = join(tempDir, 'storage', 'decisions');
      await fs.mkdir(decisionsDir, { recursive: true });
      await fs.writeFile(
        join(decisionsDir, `${childId}.json`),
        JSON.stringify(childData)
      );

      const chain = await service.getChain(childId);
      expect(chain).toHaveLength(1);
      expect(chain[0]?.id).toBe(childId);
    });

    it('breaks on cycle detection', async () => {
      // To test cycle detection we need to manipulate files directly
      // since service.create won't let us easily create a cycle
      const fs = await import('fs/promises');

      const a = { id: 'decision_a', parentDecisionId: 'decision_b' };
      const b = { id: 'decision_b', parentDecisionId: 'decision_a' };

      const decisionsDir = join(tempDir, 'storage', 'decisions');
      await fs.mkdir(decisionsDir, { recursive: true });
      await fs.writeFile(join(decisionsDir, 'decision_a.json'), JSON.stringify(a));
      await fs.writeFile(join(decisionsDir, 'decision_b.json'), JSON.stringify(b));

      const chain = await service.getChain('decision_a');
      expect(chain).toHaveLength(2); // Should find a, then b, then stop to avoid cycle
      expect(chain[0]?.id).toBe('decision_b');
      expect(chain[1]?.id).toBe('decision_a');
    });
  });

  describe('updateAssumption', () => {
    it('updates a specific assumption', async () => {
      const decision = await service.create({
        inputContext: 'Test',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
        assumptions: ['First assumption', 'Second assumption']
      });

      const originalTimestamp = decision.assumptions[1]?.updatedAt;

      // Need a tiny delay so the timestamp will be noticeably different
      await new Promise(r => setTimeout(r, 10));

      const updated = await service.updateAssumption(decision.id, 1, {
        status: 'validated',
        note: 'Looks good'
      });

      expect(updated.assumptions[0]?.status).toBe('pending');
      expect(updated.assumptions[1]?.status).toBe('validated');
      expect(updated.assumptions[1]?.note).toBe('Looks good');
      expect(updated.assumptions[1]?.updatedAt).not.toBe(originalTimestamp);
    });

    it('throws if decision not found', async () => {
      await expect(service.updateAssumption('missing-decision', 0, {
        status: 'validated'
      })).rejects.toThrow('Decision not found');
    });

    it('throws if assumption index out of bounds', async () => {
      const decision = await service.create({
        inputContext: 'Test',
        outputAction: 'Action',
        confidenceLevel: 1.0,
        riskScore: 0.0,
        assumptions: ['First assumption']
      });

      await expect(service.updateAssumption(decision.id, 5, {
        status: 'validated'
      })).rejects.toThrow('Assumption not found');
    });
  });
});
