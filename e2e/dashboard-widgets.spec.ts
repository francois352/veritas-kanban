import { test, expect } from '@playwright/test';
import { bypassAuth, cleanupRoutes, seedTestTask } from './helpers/auth';

test.describe('Dashboard Widgets', () => {
  let testTaskId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await bypassAuth(page);
    const task = await seedTestTask(page, {
      title: 'Metrics Widget Test Task',
      status: 'todo',
      priority: 'high',
    });
    testTaskId = (task as { id: string }).id;
  });

  test.afterEach(async ({ page }) => {
    await cleanupRoutes(page);
  });

  test('dashboard renders and displays widgets on kanban board', async ({ page }) => {
    await page.goto('/');

    // Wait for the Kanban board elements
    await expect(page.getByPlaceholder('Search tasks...')).toBeVisible({ timeout: 15_000 });

    // The Dashboard is rendered at the bottom of the Kanban board when `showDashboard` is true
    // Check for specific widgets based on Dashboard.tsx GridWidgetConfig titles
    await expect(page.getByRole('heading', { name: 'Agent Comparison' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Agent Utilization' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cost per Task' })).toBeVisible();
  });

  test('time period filters can be interacted with', async ({ page }) => {
    await page.goto('/');

    // Wait for the Kanban board elements
    await expect(page.getByPlaceholder('Search tasks...')).toBeVisible({ timeout: 15_000 });

    // Click on 1 Month button for time filter
    const option1Month = page.getByRole('button', { name: '1 Month' });
    await expect(option1Month).toBeVisible();
    await option1Month.click();
  });
});
