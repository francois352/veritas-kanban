import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';
import { getProjectRoot, getTasksActiveDir, getTasksArchiveDir } from '../utils/paths.js';

const log = createLogger('search-service');

export type SearchBackend = 'auto' | 'qmd' | 'keyword';
export type SearchCollection = 'tasks-active' | 'tasks-archive' | 'docs';

export interface SearchRequest {
  query: string;
  limit?: number;
  collections?: SearchCollection[];
  backend?: SearchBackend;
  minScore?: number;
}

export interface SearchResult {
  id: string;
  title: string;
  path: string;
  collection: SearchCollection | string;
  snippet: string;
  score: number;
}

export interface SearchResponse {
  query: string;
  backend: 'qmd' | 'keyword';
  degraded: boolean;
  reason?: string;
  elapsedMs: number;
  results: SearchResult[];
}

export interface SearchIndexRefreshResponse {
  backend: 'qmd';
  updated: boolean;
  embedded: boolean;
  elapsedMs: number;
  commands: string[];
}

interface SearchSource {
  collection: SearchCollection;
  dir: string;
}

const DEFAULT_COLLECTIONS: SearchCollection[] = ['tasks-active', 'tasks-archive', 'docs'];
const MAX_LIMIT = 50;
const DEFAULT_QMD_TIMEOUT_MS = 10_000;
const DEFAULT_QMD_REFRESH_TIMEOUT_MS = 60_000;

class SearchService {
  async search(request: SearchRequest): Promise<SearchResponse> {
    const started = Date.now();
    const query = request.query.trim();
    const limit = Math.min(Math.max(request.limit ?? 10, 1), MAX_LIMIT);
    const backend = request.backend ?? this.defaultBackend();

    if (!query) {
      return {
        query,
        backend: 'keyword',
        degraded: backend === 'qmd',
        reason: 'Empty query',
        elapsedMs: Date.now() - started,
        results: [],
      };
    }

    if (backend === 'qmd' || backend === 'auto') {
      try {
        const results = await this.searchWithQmd(query, {
          limit,
          collections: this.normalizeCollections(request.collections),
          minScore: request.minScore,
        });
        return {
          query,
          backend: 'qmd',
          degraded: false,
          elapsedMs: Date.now() - started,
          results,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'QMD search failed';
        log.warn({ err }, 'QMD search unavailable; falling back to keyword search');
        const results = await this.searchKeyword(query, {
          limit,
          collections: request.collections,
        });
        const fallbackReason =
          request.minScore !== undefined
            ? `${reason}; minScore ignored by keyword fallback`
            : reason;
        return {
          query,
          backend: 'keyword',
          degraded: true,
          reason: fallbackReason,
          elapsedMs: Date.now() - started,
          results,
        };
      }
    }

    const results = await this.searchKeyword(query, {
      limit,
      collections: request.collections,
    });
    return {
      query,
      backend: 'keyword',
      degraded: false,
      elapsedMs: Date.now() - started,
      results,
    };
  }

  async refreshIndex(options: { embed?: boolean } = {}): Promise<SearchIndexRefreshResponse> {
    const started = Date.now();
    const embed = options.embed ?? true;
    const timeout = this.parseTimeout(
      process.env.VERITAS_QMD_REFRESH_TIMEOUT_MS,
      DEFAULT_QMD_REFRESH_TIMEOUT_MS
    );
    const commands = await this.refreshQmdCollections(timeout);

    commands.push('update');
    await this.runQmdCommand(['update'], timeout);

    if (embed) {
      commands.push('embed');
      await this.runQmdCommand(['embed'], timeout);
    }

    return {
      backend: 'qmd',
      updated: true,
      embedded: embed,
      elapsedMs: Date.now() - started,
      commands,
    };
  }

  private async refreshQmdCollections(timeout: number): Promise<string[]> {
    const commands: string[] = [];
    const sources = this.sources(DEFAULT_COLLECTIONS);

    await Promise.all(sources.map((source) => fs.mkdir(source.dir, { recursive: true })));

    for (const source of sources) {
      commands.push(`collection remove ${source.collection}`);
      await this.runOptionalQmdCommand(['collection', 'remove', source.collection], timeout);

      commands.push(`collection add ${source.collection}`);
      await this.runQmdCommand(
        ['collection', 'add', source.dir, '--name', source.collection],
        timeout
      );
    }

    return commands;
  }

  private defaultBackend(): SearchBackend {
    const configured = process.env.VERITAS_SEARCH_BACKEND;
    if (configured === 'qmd' || configured === 'auto' || configured === 'keyword') {
      return configured;
    }
    return 'keyword';
  }

  private async searchWithQmd(
    query: string,
    options: { limit: number; collections: SearchCollection[]; minScore?: number }
  ): Promise<SearchResult[]> {
    const args = ['query', '--json', '-n', String(options.limit)];

    if (options.minScore !== undefined) {
      args.push('--min-score', String(options.minScore));
    }

    if (options.collections.length > 0) {
      args.push('--collections', options.collections.join(','));
    }

    args.push('--', query);

    const stdout = await this.runQmdCommand(
      args,
      this.parseTimeout(process.env.VERITAS_QMD_TIMEOUT_MS, DEFAULT_QMD_TIMEOUT_MS)
    );

    return this.normalizeQmdResults(stdout, options.limit);
  }

  private async runQmdCommand(args: string[], timeout: number): Promise<string> {
    const bin = process.env.VERITAS_QMD_BIN || 'qmd';
    return new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          cwd: this.projectRoot(),
          timeout,
          maxBuffer: 2 * 1024 * 1024,
        },
        (error, stdoutValue, stderrValue) => {
          if (error) {
            const stderr = String(stderrValue ?? '').trim();
            if (stderr) {
              error.message = `${error.message}\n${stderr}`;
            }
            reject(error);
            return;
          }
          resolve(String(stdoutValue ?? ''));
        }
      );
    });
  }

  private async runOptionalQmdCommand(args: string[], timeout: number): Promise<void> {
    try {
      await this.runQmdCommand(args, timeout);
    } catch (err) {
      if (this.isMissingQmdCollectionError(err)) {
        log.debug({ err, args }, 'Optional QMD collection removal skipped');
        return;
      }
      throw err;
    }
  }

  private isMissingQmdCollectionError(err: unknown): boolean {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    return (
      message.includes('collection not found') ||
      message.includes('no such collection') ||
      message.includes('unknown collection')
    );
  }

  private parseTimeout(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return fallback;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private normalizeQmdResults(stdout: string, limit: number): SearchResult[] {
    const parsed = JSON.parse(stdout || '[]') as unknown;
    const rawResults = this.extractQmdResultArray(parsed);

    return rawResults.slice(0, limit).map((raw, index) => {
      const item = raw as Record<string, unknown>;
      const rawFilePath = this.firstString(item.path, item.file, item.filename, item.id) ?? '';
      const snippet =
        this.firstString(item.snippet, item.context, item.text, item.content, item.body) ?? '';
      const collection = this.normalizeCollection(
        this.firstString(item.collection, item.source),
        rawFilePath
      );
      const score =
        this.firstNumber(item.score, item.relevance, item.rankScore) ?? 1 - index / limit;
      const filePath = this.normalizeResultPath(rawFilePath, collection);
      const title =
        (this.firstString(item.title, item.name) ??
          (filePath === 'unknown' ? 'Result' : path.basename(filePath))) ||
        'Result';

      return {
        id: filePath === 'unknown' ? `${collection}:result:${index}` : `${collection}:${filePath}`,
        title,
        path: filePath,
        collection,
        snippet: snippet.slice(0, 500),
        score,
      };
    });
  }

  private extractQmdResultArray(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['results', 'documents', 'matches', 'data']) {
        const value = obj[key];
        if (Array.isArray(value)) return value;
      }
    }
    return [];
  }

  private normalizeCollection(
    rawCollection: string | undefined,
    rawPath: string
  ): SearchCollection | 'unknown' {
    if (this.isSearchCollection(rawCollection)) return rawCollection;

    const sourceCollection = this.collectionFromAbsolutePath(rawPath);
    if (sourceCollection) return sourceCollection;

    return this.inferCollection(rawPath);
  }

  private normalizeResultPath(rawPath: string, collection: string): string {
    const cleaned = rawPath.trim();
    if (!cleaned) return 'unknown';

    const sources = this.sources(DEFAULT_COLLECTIONS);
    const absolutePath = this.absolutePathFromRaw(cleaned);
    if (absolutePath) {
      const matched = this.relativePathFromSources(absolutePath, sources);
      if (matched) return matched;
      return 'unknown';
    }

    const normalized = cleaned.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!this.isSafeRelativePath(normalized)) {
      return this.safeBasenamePath(cleaned, collection);
    }

    const collectionPrefix = this.collectionPath(collection);
    if (!collectionPrefix) return normalized;
    if (normalized === collectionPrefix || normalized.startsWith(`${collectionPrefix}/`)) {
      return normalized;
    }
    return path.posix.join(collectionPrefix, normalized);
  }

  private isSearchCollection(value: string | undefined): value is SearchCollection {
    return value === 'tasks-active' || value === 'tasks-archive' || value === 'docs';
  }

  private absolutePathFromRaw(rawPath: string): string | null {
    if (path.isAbsolute(rawPath)) return path.resolve(rawPath);
    if (path.win32.isAbsolute(rawPath)) return rawPath;
    return null;
  }

  private collectionFromAbsolutePath(rawPath: string): SearchCollection | null {
    const absolutePath = this.absolutePathFromRaw(rawPath);
    if (!absolutePath) return null;

    const normalizedAbsolute = absolutePath.replace(/\\/g, '/');
    for (const source of this.sources(DEFAULT_COLLECTIONS)) {
      const sourceDir = source.dir.replace(/\\/g, '/');
      const relative = path.posix.relative(sourceDir, normalizedAbsolute);
      if (!relative || relative.startsWith('..') || path.posix.isAbsolute(relative)) continue;
      return source.collection;
    }

    return null;
  }

  private relativePathFromSources(absolutePath: string, sources: SearchSource[]): string | null {
    const normalizedAbsolute = absolutePath.replace(/\\/g, '/');

    for (const source of sources) {
      const sourceDir = source.dir.replace(/\\/g, '/');
      const relative = path.posix.relative(sourceDir, normalizedAbsolute);
      if (!relative || relative.startsWith('..') || path.posix.isAbsolute(relative)) continue;

      const collectionPrefix = this.collectionPath(source.collection);
      return collectionPrefix ? path.posix.join(collectionPrefix, relative) : relative;
    }

    return null;
  }

  private safeBasenamePath(rawPath: string, collection: string): string {
    const basename = path.basename(rawPath.replace(/\\/g, '/'));
    if (!basename || basename === '.' || basename === '..') return 'unknown';

    const collectionPrefix = this.collectionPath(collection);
    return collectionPrefix ? path.posix.join(collectionPrefix, basename) : basename;
  }

  private isSafeRelativePath(value: string): boolean {
    return (
      value.length > 0 &&
      !value.startsWith('/') &&
      !path.win32.isAbsolute(value) &&
      !value.split('/').includes('..')
    );
  }

  private collectionPath(collection: string): string | null {
    if (collection === 'tasks-active') return 'tasks/active';
    if (collection === 'tasks-archive') return 'tasks/archive';
    if (collection === 'docs') return 'docs';
    return null;
  }

  private async searchKeyword(
    query: string,
    options: { limit: number; collections?: SearchCollection[] }
  ): Promise<SearchResult[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);

    if (terms.length === 0) return [];

    const results: SearchResult[] = [];
    const sources = this.sources(options.collections);

    for (const source of sources) {
      const files = await this.listMarkdownFiles(source.dir);
      for (const file of files) {
        const result = await this.scoreFile(file, source, terms);
        if (result) results.push(result);
      }
    }

    return results
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, options.limit);
  }

  private async scoreFile(
    filePath: string,
    source: SearchSource,
    terms: string[]
  ): Promise<SearchResult | null> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }

    const haystack = content.toLowerCase();
    const relativePath = path.relative(this.projectRoot(), filePath);
    const pathHaystack = relativePath.toLowerCase();
    let score = 0;

    for (const term of terms) {
      if (pathHaystack.includes(term)) score += 3;
      const matches = haystack.match(new RegExp(this.escapeRegExp(term), 'g'))?.length ?? 0;
      score += matches;
    }

    if (score === 0) return null;

    return {
      id: relativePath,
      title: this.extractTitle(content, filePath),
      path: relativePath,
      collection: source.collection,
      snippet: this.extractSnippet(content, terms),
      score,
    };
  }

  private sources(collections?: SearchCollection[]): SearchSource[] {
    const selected = new Set(this.normalizeCollections(collections));
    const root = this.projectRoot();
    const searchRoot = process.env.VERITAS_SEARCH_ROOT;
    const candidates: SearchSource[] = [
      {
        collection: 'tasks-active',
        dir:
          process.env.VERITAS_SEARCH_TASKS_ACTIVE_DIR ||
          (searchRoot ? path.join(searchRoot, 'tasks', 'active') : getTasksActiveDir()),
      },
      {
        collection: 'tasks-archive',
        dir:
          process.env.VERITAS_SEARCH_TASKS_ARCHIVE_DIR ||
          (searchRoot ? path.join(searchRoot, 'tasks', 'archive') : getTasksArchiveDir()),
      },
      {
        collection: 'docs',
        dir: process.env.VERITAS_SEARCH_DOCS_DIR || path.join(root, 'docs'),
      },
    ];

    return candidates.filter((source) => selected.has(source.collection));
  }

  private normalizeCollections(collections?: SearchCollection[]): SearchCollection[] {
    if (!collections || collections.length === 0) return DEFAULT_COLLECTIONS;
    const allowed = new Set<SearchCollection>(DEFAULT_COLLECTIONS);
    return collections.filter((collection) => allowed.has(collection));
  }

  private async listMarkdownFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listMarkdownFiles(fullPath)));
      } else if (entry.isFile() && /\.(md|mdx|txt)$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  private extractTitle(content: string, filePath: string): string {
    const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (heading) return heading;

    const titleField = content.match(/^title:\s*['"]?(.+?)['"]?\s*$/m)?.[1]?.trim();
    if (titleField) return titleField;

    return path.basename(filePath).replace(/\.(md|mdx|txt)$/i, '');
  }

  private extractSnippet(content: string, terms: string[]): string {
    const lines = content.split('\n');
    const match = lines.find((line) => {
      const lower = line.toLowerCase();
      return terms.some((term) => lower.includes(term));
    });
    return (match || lines.find((line) => line.trim()) || '').trim().slice(0, 500);
  }

  private projectRoot(): string {
    return process.env.VERITAS_SEARCH_ROOT || getProjectRoot();
  }

  private inferCollection(filePath: string): SearchCollection | 'unknown' {
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (normalizedPath.includes('tasks/archive')) return 'tasks-archive';
    if (normalizedPath.includes('tasks/active')) return 'tasks-active';
    if (
      normalizedPath === 'docs' ||
      normalizedPath.startsWith('docs/') ||
      normalizedPath.includes('/docs/')
    ) {
      return 'docs';
    }
    return 'unknown';
  }

  private firstString(...values: unknown[]): string | undefined {
    const found = values.find((value) => typeof value === 'string' && value.length > 0);
    return found as string | undefined;
  }

  private firstNumber(...values: unknown[]): number | undefined {
    const found = values.find((value) => typeof value === 'number' && Number.isFinite(value));
    return found as number | undefined;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

let instance: SearchService | null = null;

export function getSearchService(): SearchService {
  if (!instance) {
    instance = new SearchService();
  }
  return instance;
}

export { SearchService };
