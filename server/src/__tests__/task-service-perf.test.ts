import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TaskService } from '../services/task-service.js';

describe('TaskService Performance', () => {
  let testRoot: string;
  let tasksDir: string;
  let archiveDir: string;

  beforeEach(async () => {
    const uniqueSuffix = Math.random().toString(36).substring(7);
    testRoot = path.join(os.tmpdir(), `veritas-perf-tasks-${uniqueSuffix}`);
    tasksDir = path.join(testRoot, 'active');
    archiveDir = path.join(testRoot, 'archive');

    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(archiveDir, { recursive: true });

    // Create 100 mock task files
    const createPromises = [];
    for (let i = 0; i < 100; i++) {
      const filename = `task_${i.toString().padStart(3, '0')}.md`;
      const filepath = path.join(tasksDir, filename);
      const content = `---
id: task_perf_${i}
title: Perf Task ${i}
status: todo
---
This is a performance test task.
`;
      createPromises.push(fs.writeFile(filepath, content, 'utf-8'));
    }
    await Promise.all(createPromises);
  });

  afterEach(async () => {
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  });

  it('batched reads should be faster than sequential reads', async () => {
    // We instantiate one service to use its parseTaskFile privately for fairness
    const dummyService = new TaskService({ tasksDir, archiveDir });

    // 1. Measure sequential read + parse time
    const startSequential = performance.now();
    const files = await fs.readdir(tasksDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    // Naive sequential reading
    for (const filename of mdFiles) {
      const filepath = path.join(tasksDir, filename);
      const content = await fs.readFile(filepath, 'utf-8');
      (dummyService as any).parseTaskFile(content, filename);
    }
    const sequentialTime = performance.now() - startSequential;
    dummyService.dispose();

    // 2. Measure TaskService batched read time
    const service = new TaskService({ tasksDir, archiveDir });
    const startBatched = performance.now();
    const tasks = await service.listTasks();
    const batchedTime = performance.now() - startBatched;

    expect(tasks.length).toBe(100);

    console.log(`Sequential: ${sequentialTime.toFixed(2)}ms, Batched: ${batchedTime.toFixed(2)}ms`);
    expect(batchedTime).toBeLessThan(sequentialTime);

    service.dispose();
  });
});
