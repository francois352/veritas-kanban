import { useState } from 'react';
import { PromptTemplate } from '@veritas-kanban/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface TemplateListProps {
  templates: PromptTemplate[];
  onSelect: (template: PromptTemplate) => void;
  onCreateNew: () => void;
}

export function TemplateList({ templates, onSelect, onCreateNew }: TemplateListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string>('');

  const allTags = Array.from(new Set(templates.flatMap((t: PromptTemplate) => t.tags)));

  const filteredTemplates = templates.filter((t: PromptTemplate) => {
    const matchesSearch = t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          t.description?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesTag = tagFilter === '' || t.tags.includes(tagFilter);
    return matchesSearch && matchesTag;
  });

  return (
    <Card className="flex flex-col h-full border-none shadow-none">
      <CardHeader className="flex flex-row items-center justify-between pb-2 px-0">
        <div>
          <CardTitle>Prompt Templates</CardTitle>
          <CardDescription>Manage and version your AI prompt templates.</CardDescription>
        </div>
        <Button onClick={onCreateNew}>Create Template</Button>
      </CardHeader>

      <div className="flex items-center gap-4 py-4">
        <Input
          placeholder="Search templates..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-sm"
        />
        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="h-10 w-[180px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">All Tags</option>
          {allTags.map((tag: string) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
      </div>

      <CardContent className="flex-1 p-0 mt-4 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Last Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTemplates.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center h-24 text-muted-foreground">
                  No templates found.
                </TableCell>
              </TableRow>
            ) : (
              filteredTemplates.map((template: PromptTemplate) => (
                <TableRow
                  key={template.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => onSelect(template)}
                >
                  <TableCell className="font-medium">
                    <div>{template.name}</div>
                    {template.description && (
                      <div className="text-xs text-muted-foreground line-clamp-1">
                        {template.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>v{template.version}</TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {template.tags.map((tag: string) => (
                        <Badge key={tag} variant="secondary" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {new Date(template.updatedAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
