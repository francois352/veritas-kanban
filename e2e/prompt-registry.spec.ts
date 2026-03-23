import { test, expect } from '@playwright/test';
import { bypassAuth, cleanupRoutes, seedTestTask } from './helpers/auth';

test.describe('Prompt Registry', () => {
  let testTaskId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await bypassAuth(page);
    const task = await seedTestTask(page, {
      title: 'Prompt Registry Test Task',
      status: 'todo',
      priority: 'high',
    });
    testTaskId = (task as { id: string }).id;
  });

  test.afterEach(async ({ page }) => {
    await cleanupRoutes(page);
  });

  test('prompt registry page loads and displays templates', async ({ page }) => {
    await page.goto('/');

    // Wait for the Kanban board elements to ensure app is ready
    await expect(page.getByPlaceholder('Search tasks...')).toBeVisible({ timeout: 15_000 });

    // Navigate to Prompt Registry via header button
    const templatesBtn = page.getByRole('button', { name: 'Templates', exact: true }).or(page.locator('header button[title*="Templates"]')).first();
    await expect(templatesBtn).toBeVisible();
    await templatesBtn.click();

    // Verify page loads and display is visible
    // Update the heading name based on the actual component (e.g., "Prompt Registry", "Templates")
    await expect(page.getByRole('heading', { name: /Templates|Prompt Registry/i }).first()).toBeVisible({ timeout: 10_000 });

    // Check for standard UI elements in the registry
    await expect(page.getByPlaceholder('Search templates...').or(page.getByPlaceholder('Search'))).toBeVisible();

    // Verify there is a way to create a template
    const createBtn = page.getByRole('button', { name: /Create|New Template/i });
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    // Verify the dialog or form opens
    await expect(page.getByRole('dialog').or(page.locator('.modal'))).toBeVisible();
    await expect(page.getByRole('heading', { name: /Create|New Template/i }).first()).toBeVisible();
  });
});
