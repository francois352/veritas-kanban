import { readdir, readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { fileExists } from '../storage/fs-helpers.js';
import { join } from 'path';
import matter from 'gray-matter';
import { createLogger } from '../lib/logger.js';
import { validatePathSegment, ensureWithinBase } from '../utils/sanitize.js';

const log = createLogger('prompt-template-service');

export interface TemplateVersion {
  version: number;
  content: string;
  changelog: string;
  createdAt: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
  variables: string[];
  version: number;
  versions: TemplateVersion[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export class PromptTemplateService {
  private templatesDir: string;

  constructor() {
    this.templatesDir = join(process.cwd(), '.veritas-kanban', 'prompt-templates');
    this.ensureDir();
  }

  private async ensureDir() {
    await mkdir(this.templatesDir, { recursive: true });
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private templatePath(id: string): string {
    validatePathSegment(id);
    const filepath = join(this.templatesDir, `${id}.json`);
    ensureWithinBase(this.templatesDir, filepath);
    return filepath;
  }

  private extractVariables(content: string): string[] {
    const matches = content.match(/\{\{([^}]+)\}\}/g) || [];
    const vars = matches.map((m) => m.slice(2, -2).trim());
    return [...new Set(vars)];
  }

  async listTemplates(tag?: string): Promise<PromptTemplate[]> {
    await this.ensureDir();

    const files = await readdir(this.templatesDir);
    const templates: PromptTemplate[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await readFile(join(this.templatesDir, file), 'utf-8');
        const template = JSON.parse(content) as PromptTemplate;
        if (!tag || template.tags.includes(tag)) {
          templates.push(template);
        }
      } catch (err) {
        log.error({ err: err }, `Error reading prompt template ${file}`);
      }
    }

    return templates.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getTemplate(id: string): Promise<PromptTemplate | null> {
    const path = this.templatePath(id);

    if (!(await fileExists(path))) {
      return null;
    }

    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content) as PromptTemplate;
    } catch (err) {
      log.error({ err: err }, `Error reading prompt template ${id}`);
      return null;
    }
  }

  async createTemplate(input: {
    name: string;
    description?: string;
    content: string;
    tags?: string[];
    changelog?: string;
  }): Promise<PromptTemplate> {
    await this.ensureDir();

    const id = `ptpl_${this.slugify(input.name)}_${Date.now()}`;
    const now = new Date().toISOString();

    const initialVersion: TemplateVersion = {
      version: 1,
      content: input.content,
      changelog: input.changelog || 'Initial creation',
      createdAt: now,
    };

    const template: PromptTemplate = {
      id,
      name: input.name,
      description: input.description || '',
      content: input.content,
      variables: this.extractVariables(input.content),
      version: 1,
      versions: [initialVersion],
      tags: input.tags || [],
      createdAt: now,
      updatedAt: now,
    };

    await writeFile(this.templatePath(id), JSON.stringify(template, null, 2), 'utf-8');
    return template;
  }

  async updateTemplate(
    id: string,
    input: {
      name?: string;
      description?: string;
      content?: string;
      tags?: string[];
      changelog?: string;
    }
  ): Promise<PromptTemplate | null> {
    const existing = await this.getTemplate(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated = { ...existing };
    let newVersionNeeded = false;

    if (input.name !== undefined) updated.name = input.name;
    if (input.description !== undefined) updated.description = input.description;
    if (input.tags !== undefined) updated.tags = input.tags;

    if (input.content !== undefined && input.content !== existing.content) {
      newVersionNeeded = true;
      updated.content = input.content;
      updated.variables = this.extractVariables(input.content);
      updated.version += 1;

      const newVersion: TemplateVersion = {
        version: updated.version,
        content: input.content,
        changelog: input.changelog || `Updated content to version ${updated.version}`,
        createdAt: now,
      };

      updated.versions.push(newVersion);
    }

    updated.updatedAt = now;

    await writeFile(this.templatePath(id), JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
  }

  renderTemplate(id: string, variables: Record<string, string>, content?: string): string {
    let rendered = content || '';
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
      rendered = rendered.replace(regex, value);
    }
    return rendered;
  }

  async renderTemplateById(id: string, variables: Record<string, string>): Promise<string | null> {
    const template = await this.getTemplate(id);
    if (!template) return null;
    return this.renderTemplate(id, variables, template.content);
  }

  async deleteTemplate(id: string): Promise<boolean> {
    const path = this.templatePath(id);

    if (!(await fileExists(path))) {
      return false;
    }

    await unlink(path);
    return true;
  }
}
