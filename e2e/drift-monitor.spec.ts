import { test, expect } from '@playwright/test';
import { bypassAuth, cleanupRoutes, seedTestTask } from './helpers/auth';

test.describe('Drift Monitor', () => {
  let testTaskId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await bypassAuth(page);
    const task = await seedTestTask(page, {
      title: 'Drift Monitor Test Task',
      status: 'todo',
      priority: 'high',
    });
    testTaskId = (task as { id: string }).id;
  });

  test.afterEach(async ({ page }) => {
    await cleanupRoutes(page);
  });

  test('drift monitor page loads and displays sections', async ({ page }) => {
    await page.goto('/');

    // Wait for the Kanban board elements to ensure app is ready
    await expect(page.getByPlaceholder('Search tasks...')).toBeVisible({ timeout: 15_000 });

    // Navigate to Drift Monitor via header button
    const driftBtn = page.getByRole('button', { name: 'Drift Monitor', exact: true }).or(page.locator('header button[title*="Drift Monitor"]')).first();
    await expect(driftBtn).toBeVisible();
    await driftBtn.click();

    // Verify page loads and baseline display is visible
    await expect(page.getByRole('heading', { name: 'Behavioral Drift Monitor' }).first()).toBeVisible({ timeout: 10_000 });

    // Check for sub-headings like 'Baselines', 'Alerts'
    // Let's rely on text or headings common in DriftMonitor.tsx
    await expect(page.getByRole('heading', { name: 'Baselines' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Alerts' }).first()).toBeVisible();
  });
});
