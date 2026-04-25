import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const mockGetDecisionsDir = vi.fn();

vi.mock('../utils/paths.js', () => ({
  getDecisionsDir: mockGetDecisionsDir,
}));

describe('DecisionService', () => {
  let tmpDir: string;
  let service: any;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-service-'));
    mockGetDecisionsDir.mockReturnValue(tmpDir);
    const mod = await import('../services/decision-service.js');
    service = new mod.DecisionService();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates decisions and normalizes assumptions', async () => {
    const created = await service.create({
      inputContext: 'Need an architecture choice',
      outputAction: 'Pick Postgres',
      assumptions: ['traffic stays low', { text: 'team knows SQL' }],
      confidenceLevel: 0.8,
      riskScore: 0.2,
      agentId: 'VERITAS',
      taskId: 'task-1',
      timestamp: '2026-03-01T00:00:00.000Z',
    });

    expect(created.id).toMatch(/^decision_/);
    expect(created.assumptions).toEqual([
      {
        text: 'traffic stays low',
        status: 'pending',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
      {
        text: 'team knows SQL',
        status: 'pending',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ]);

    const saved = JSON.parse(await fs.readFile(path.join(tmpDir, `${created.id}.json`), 'utf8'));
    expect(saved.outputAction).toBe('Pick Postgres');
  });

  it('rejects missing parent decisions', async () => {
    await expect(
      service.create({
        inputContext: 'x',
        outputAction: 'y',
        confidenceLevel: 0.5,
        riskScore: 0.5,
        parentDecisionId: 'missing-parent',
      })
    ).rejects.toThrow(/Parent decision not found/);
  });

  it('lists decisions with filters and newest first', async () => {
    const older = await service.create({
      inputContext: 'a',
      outputAction: 'a',
      confidenceLevel: 0.3,
      riskScore: 0.7,
      agentId: 'A',
      timestamp: '2026-03-01T00:00:00.000Z',
    });
    const newer = await service.create({
      inputContext: 'b',
      outputAction: 'b',
      confidenceLevel: 0.9,
      riskScore: 0.1,
      agentId: 'B',
      timestamp: '2026-03-03T00:00:00.000Z',
    });

    const filtered = await service.list({
      agent: 'B',
      minConfidence: 0.8,
      maxRisk: 0.2,
      startTime: '2026-03-02T00:00:00.000Z',
      endTime: '2026-03-04T00:00:00.000Z',
    });

    expect(filtered.map((d: any) => d.id)).toEqual([newer.id]);
    const all = await service.list();
    expect(all.map((d: any) => d.id)).toEqual([newer.id, older.id]);
  });

  it('gets chains in root-to-leaf order and breaks cycles', async () => {
    const root = await service.create({
      inputContext: 'root',
      outputAction: 'root',
      confidenceLevel: 0.8,
      riskScore: 0.1,
    });
    const child = await service.create({
      inputContext: 'child',
      outputAction: 'child',
      confidenceLevel: 0.7,
      riskScore: 0.2,
      parentDecisionId: root.id,
    });

    expect((await service.getChain(child.id)).map((d: any) => d.id)).toEqual([root.id, child.id]);

    const cyclic = {
      ...root,
      parentDecisionId: child.id,
    };
    await fs.writeFile(
      path.join(tmpDir, `${root.id}.json`),
      JSON.stringify(cyclic, null, 2),
      'utf8'
    );

    const cycleChain = await service.getChain(child.id);
    expect(cycleChain.map((d: any) => d.id)).toEqual([root.id, child.id]);
  });

  it('updates assumptions and errors on missing decision or assumption', async () => {
    const created = await service.create({
      inputContext: 'ctx',
      outputAction: 'act',
      assumptions: ['first'],
      confidenceLevel: 0.5,
      riskScore: 0.4,
    });

    const updated = await service.updateAssumption(created.id, 0, {
      status: 'validated',
      note: 'checked',
    });

    expect(updated.assumptions[0].status).toBe('validated');
    expect(updated.assumptions[0].note).toBe('checked');

    await expect(service.updateAssumption('missing', 0, { status: 'invalidated' })).rejects.toThrow(
      /Decision not found/
    );
    await expect(
      service.updateAssumption(created.id, 4, { status: 'invalidated' })
    ).rejects.toThrow(/Assumption not found/);
  });

  it('returns null for unknown decision ids', async () => {
    await expect(service.getById('missing')).resolves.toBeNull();
  });
});
