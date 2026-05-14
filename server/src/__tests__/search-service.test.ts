import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SearchService } from '../services/search-service.js';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

describe('SearchService', () => {
  let root: string;
  let oldEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    oldEnv = { ...process.env };
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-search-'));
    await fs.mkdir(path.join(root, 'tasks', 'active'), { recursive: true });
    await fs.mkdir(path.join(root, 'tasks', 'archive'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    process.env.VERITAS_SEARCH_ROOT = root;
    process.env.VERITAS_SEARCH_BACKEND = 'keyword';
    execFileMock.mockReset();
  });

  afterEach(async () => {
    process.env = oldEnv;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('searches task and docs markdown with keyword fallback', async () => {
    await fs.writeFile(
      path.join(root, 'tasks', 'active', 'task_1.md'),
      '# Add semantic search\n\nWire QMD retrieval into Veritas.',
      'utf-8'
    );
    await fs.writeFile(
      path.join(root, 'docs', 'search.md'),
      '# Search Guide\n\nQMD setup notes.',
      'utf-8'
    );

    const result = await new SearchService().search({ query: 'QMD retrieval', limit: 5 });

    expect(result.backend).toBe('keyword');
    expect(result.degraded).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].path).toContain('tasks/active/task_1.md');
  });

  it('honors DATA_DIR task storage when search root is not overridden', async () => {
    delete process.env.VERITAS_SEARCH_ROOT;
    const dataRoot = path.join(root, 'data-root');
    await fs.mkdir(path.join(dataRoot, 'tasks', 'active'), { recursive: true });
    await fs.mkdir(path.join(dataRoot, 'tasks', 'archive'), { recursive: true });
    process.env.DATA_DIR = dataRoot;

    await fs.writeFile(
      path.join(dataRoot, 'tasks', 'active', 'task_20260514_data01.md'),
      '# Production DATA_DIR Task\n\ndata-dir-only-needle',
      'utf-8'
    );

    const result = await new SearchService().search({
      query: 'data-dir-only-needle',
      backend: 'keyword',
      collections: ['tasks-active'],
      limit: 5,
    });

    expect(result.backend).toBe('keyword');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toContain('tasks/active/task_20260514_data01.md');
  });

  it('falls back to keyword search when qmd fails', async () => {
    process.env.VERITAS_SEARCH_BACKEND = 'qmd';
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(new Error('qmd not found'), '', '');
    });
    await fs.writeFile(path.join(root, 'docs', 'qmd.md'), '# QMD\n\nlocal retrieval', 'utf-8');

    const result = await new SearchService().search({ query: 'retrieval', limit: 5 });

    expect(result.backend).toBe('keyword');
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('qmd not found');
    expect(result.results[0].path).toContain('docs/qmd.md');
  });

  it('notes when minScore is ignored by keyword fallback', async () => {
    process.env.VERITAS_SEARCH_BACKEND = 'qmd';
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(new Error('qmd not found'), '', '');
    });
    await fs.writeFile(path.join(root, 'docs', 'qmd.md'), '# QMD\n\nlocal retrieval', 'utf-8');

    const result = await new SearchService().search({
      query: 'retrieval',
      limit: 5,
      minScore: 0.5,
    });

    expect(result.backend).toBe('keyword');
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('minScore ignored by keyword fallback');
  });

  it('normalizes qmd json results', async () => {
    process.env.VERITAS_SEARCH_BACKEND = 'qmd';
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify({
          results: [
            {
              path: 'tasks/active/task_1.md',
              title: 'Semantic search',
              snippet: 'QMD result',
              score: 0.92,
              collection: 'tasks-active',
            },
          ],
        }),
        ''
      );
    });

    const result = await new SearchService().search({ query: 'semantic search' });

    expect(result.backend).toBe('qmd');
    expect(result.degraded).toBe(false);
    expect(result.results[0]).toMatchObject({
      title: 'Semantic search',
      score: 0.92,
      collection: 'tasks-active',
    });
    expect(execFileMock).toHaveBeenCalledWith(
      'qmd',
      [
        'query',
        '--json',
        '-n',
        '10',
        '--collections',
        'tasks-active,tasks-archive,docs',
        '--',
        'semantic search',
      ],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function)
    );
  });

  it('places flag-like qmd queries after an option separator', async () => {
    process.env.VERITAS_SEARCH_BACKEND = 'qmd';
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(null, JSON.stringify({ results: [] }), '');
    });

    await new SearchService().search({ query: '--help', limit: 5 });

    expect(execFileMock).toHaveBeenCalledWith(
      'qmd',
      [
        'query',
        '--json',
        '-n',
        '5',
        '--collections',
        'tasks-active,tasks-archive,docs',
        '--',
        '--help',
      ],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('refreshes qmd index and embeddings', async () => {
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(null, '', '');
    });

    const result = await new SearchService().refreshIndex();

    expect(result).toMatchObject({
      backend: 'qmd',
      updated: true,
      embedded: true,
      commands: ['update', 'embed'],
    });
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'qmd',
      ['update'],
      expect.objectContaining({ cwd: root, timeout: 60_000 }),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'qmd',
      ['embed'],
      expect.objectContaining({ cwd: root, timeout: 60_000 }),
      expect.any(Function)
    );
  });

  it('falls back to default qmd timeouts when env values are invalid', async () => {
    process.env.VERITAS_SEARCH_BACKEND = 'qmd';
    process.env.VERITAS_QMD_TIMEOUT_MS = '10s';
    process.env.VERITAS_QMD_REFRESH_TIMEOUT_MS = '60 000';
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(null, JSON.stringify({ results: [] }), '');
    });

    await new SearchService().search({ query: 'semantic search' });
    expect(execFileMock).toHaveBeenLastCalledWith(
      'qmd',
      expect.any(Array),
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function)
    );

    execFileMock.mockClear();
    await new SearchService().refreshIndex({ embed: false });
    expect(execFileMock).toHaveBeenCalledWith(
      'qmd',
      ['update'],
      expect.objectContaining({ timeout: 60_000 }),
      expect.any(Function)
    );
  });

  it('can refresh qmd index without embedding', async () => {
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(null, '', '');
    });

    const result = await new SearchService().refreshIndex({ embed: false });

    expect(result.embedded).toBe(false);
    expect(result.commands).toEqual(['update']);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
