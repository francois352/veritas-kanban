export function extractTaskId(path: string): string | null {
  const fileName = path.split('/').pop() ?? '';
  const productionMatch = fileName.match(/^(task_\d{8}_[A-Za-z0-9_-]{6})(?:-[^/]*)?\.md$/);
  if (productionMatch) return productionMatch[1];

  const legacyMatch = fileName.match(/^(task_\d{8}_[A-Za-z0-9_]+?)(?:-[^/]*)?\.md$/);
  return legacyMatch?.[1] ?? null;
}
