import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { searchRoutes } from '../../routes/search.js';
import { errorHandler } from '../../middleware/error-handler.js';

const { mockSearch, mockRefreshIndex } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockRefreshIndex: vi.fn(),
}));

vi.mock('../../services/search-service.js', () => ({
  getSearchService: () => ({
    search: mockSearch,
    refreshIndex: mockRefreshIndex,
  }),
}));

describe('searchRoutes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const role = req.header('x-test-role');
      if (role === 'admin' || role === 'agent' || role === 'read-only') {
        (
          req as typeof req & { auth: { role: typeof role; keyName: string; isLocalhost: boolean } }
        ).auth = {
          role,
          keyName: 'test-key',
          isLocalhost: false,
        };
      }
      next();
    });
    app.use('/api/search', searchRoutes);
    app.use(errorHandler);
  });

  it('POST /api/search returns search results', async () => {
    mockSearch.mockResolvedValue({
      query: 'qmd',
      backend: 'keyword',
      degraded: false,
      elapsedMs: 3,
      results: [],
    });

    const res = await request(app)
      .post('/api/search')
      .send({ query: 'qmd', collections: ['docs'], backend: 'keyword' });

    expect(res.status).toBe(200);
    expect(res.body.backend).toBe('keyword');
    expect(mockSearch).toHaveBeenCalledWith({
      query: 'qmd',
      limit: undefined,
      collections: ['docs'],
      backend: 'keyword',
      minScore: undefined,
    });
  });

  it('POST /api/search validates query', async () => {
    const res = await request(app).post('/api/search').send({ query: '' });
    expect(res.status).toBe(400);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('POST /api/search/index/refresh refreshes the qmd index', async () => {
    mockRefreshIndex.mockResolvedValue({
      backend: 'qmd',
      updated: true,
      embedded: false,
      elapsedMs: 8,
      commands: ['update'],
    });

    const res = await request(app)
      .post('/api/search/index/refresh')
      .set('x-test-role', 'admin')
      .send({ embed: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ backend: 'qmd', updated: true, embedded: false });
    expect(mockRefreshIndex).toHaveBeenCalledWith({ embed: false });
  });

  it('POST /api/search/index/refresh requires auth', async () => {
    const res = await request(app).post('/api/search/index/refresh').send({ embed: false });

    expect(res.status).toBe(401);
    expect(mockRefreshIndex).not.toHaveBeenCalled();
  });

  it('POST /api/search/index/refresh rejects agent keys', async () => {
    const res = await request(app)
      .post('/api/search/index/refresh')
      .set('x-test-role', 'agent')
      .send({ embed: false });

    expect(res.status).toBe(403);
    expect(mockRefreshIndex).not.toHaveBeenCalled();
  });
});
