export function extractTaskId(path: string): string | null {
  const fileName = path.split('/').pop() ?? '';
  const match = fileName.match(/^(task_[^./]+?)(?:-[^/]*)?\.md$/);
  return match?.[1] ?? null;
}
