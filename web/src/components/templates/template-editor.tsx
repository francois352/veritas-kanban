import React, { useState, useEffect } from 'react';
import { PromptTemplate, TemplateVersion } from '@veritas-kanban/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Badge } from '../ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

interface TemplateEditorProps {
  template: PromptTemplate | null;
  onSave: (data: Partial<PromptTemplate> & { changelog?: string }) => Promise<void>;
  onCancel: () => void;
  onRender: (templateId: string, variables: Record<string, string>) => Promise<string>;
}

export function TemplateEditor({ template, onSave, onCancel, onRender }: TemplateEditorProps) {
  const [name, setName] = useState(template?.name || '');
  const [description, setDescription] = useState(template?.description || '');
  const [content, setContent] = useState(template?.content || '');
  const [tags, setTags] = useState(template?.tags?.join(', ') || '');
  const [changelog, setChangelog] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Test render state
  const [testVariables, setTestVariables] = useState<Record<string, string>>({});
  const [renderedContent, setRenderedContent] = useState('');
  const [isRendering, setIsRendering] = useState(false);

  // Version diff state
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(template?.version || null);

  useEffect(() => {
    if (template) {
      setName(template.name);
      setDescription(template.description || '');
      setContent(template.content);
      setTags(template.tags?.join(', ') || '');
      setSelectedVersionId(template.version);

      const vars: Record<string, string> = {};
      (template.variables || []).forEach((v: string) => vars[v] = '');
      setTestVariables(vars);
    } else {
      setName('');
      setDescription('');
      setContent('');
      setTags('');
      setTestVariables({});
      setSelectedVersionId(null);
    }
    setChangelog('');
    setRenderedContent('');
  }, [template]);

  const extractedVariables = React.useMemo<string[]>(() => {
    const matches = content.match(/\{\{([^}]+)\}\}/g) || [];
    return Array.from(new Set(matches.map((m: string) => m.slice(2, -2).trim())));
  }, [content]);

  useEffect(() => {
    // Sync test variables when extracted variables change
    const newVars = { ...testVariables };
    let changed = false;
    extractedVariables.forEach((v: string) => {
      if (!(v in newVars)) {
        newVars[v] = '';
        changed = true;
      }
    });
    if (changed) setTestVariables(newVars);
  }, [extractedVariables, testVariables]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({
        name,
        description,
        content,
        tags: tags.split(',').map((t: string) => t.trim()).filter(Boolean),
        changelog: changelog || (template ? `Update to version ${template.version + 1}` : 'Initial creation'),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestRender = async () => {
    if (!template?.id) return;
    setIsRendering(true);
    try {
      const result = await onRender(template.id, testVariables);
      setRenderedContent(result);
    } catch (e) {
      setRenderedContent(`Error rendering template: ${e}`);
    } finally {
      setIsRendering(false);
    }
  };

  const selectedVersion = template?.versions.find((v: TemplateVersion) => v.version === selectedVersionId);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-full">
      <div className="md:col-span-2 flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{template ? 'Edit Template' : 'New Template'}</CardTitle>
            <CardDescription>
              Use {'{{variable}}'} syntax to define variables in your prompt.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Template name" />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Template description" />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-sm font-medium">Content</label>
                {extractedVariables.length > 0 && (
                  <div className="flex gap-1 text-xs">
                    Variables:
                    {extractedVariables.map((v: string) => (
                      <Badge key={v} variant="outline" className="text-[10px] px-1 h-4">{v}</Badge>
                    ))}
                  </div>
                )}
              </div>
              <Textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="Enter prompt template here..."
                className="font-mono min-h-[300px]"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Tags (comma-separated)</label>
              <Input value={tags} onChange={e => setTags(e.target.value)} placeholder="tag1, tag2" />
            </div>

            {template && content !== template.content && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Changelog message (optional)</label>
                <Input value={changelog} onChange={e => setChangelog(e.target.value)} placeholder="What changed?" />
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={onCancel} disabled={isSaving}>Cancel</Button>
              <Button onClick={handleSave} disabled={!name || !content || isSaving}>
                {isSaving ? 'Saving...' : 'Save Template'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Tabs defaultValue="test" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="test">Test Render</TabsTrigger>
            <TabsTrigger value="history" disabled={!template}>History</TabsTrigger>
          </TabsList>

          <TabsContent value="test" className="space-y-4 mt-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Test Variables</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {extractedVariables.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No variables detected in template.</div>
                ) : (
                  <>
                    {extractedVariables.map((v: string) => (
                      <div key={v} className="space-y-1">
                        <label className="text-xs font-medium">{v}</label>
                        <Input
                          size={1}
                          value={testVariables[v] || ''}
                          onChange={e => setTestVariables({...testVariables, [v]: e.target.value})}
                        />
                      </div>
                    ))}
                    <Button
                      className="w-full mt-2"
                      onClick={handleTestRender}
                      disabled={!template || isRendering}
                    >
                      {isRendering ? 'Rendering...' : 'Render Preview'}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>

            {renderedContent && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Rendered Output</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="text-xs bg-muted p-2 rounded whitespace-pre-wrap font-mono">
                    {renderedContent}
                  </pre>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            {template && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Version History</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2 max-h-[200px] overflow-y-auto pr-2">
                    {template.versions.slice().reverse().map((v: TemplateVersion) => (
                      <div
                        key={v.version}
                        className={`p-2 rounded cursor-pointer border text-sm ${selectedVersionId === v.version ? 'bg-muted border-primary' : 'border-transparent hover:bg-muted/50'}`}
                        onClick={() => setSelectedVersionId(v.version)}
                      >
                        <div className="flex justify-between items-center">
                          <span className="font-semibold">v{v.version}</span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(v.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {v.changelog}
                        </div>
                      </div>
                    ))}
                  </div>

                  {selectedVersion && selectedVersionId !== template.version && (
                    <div className="pt-4 border-t">
                      <div className="text-xs font-semibold mb-2">Content for v{selectedVersion.version}:</div>
                      <pre className="text-xs bg-muted p-2 rounded whitespace-pre-wrap font-mono max-h-[300px] overflow-y-auto">
                        {selectedVersion.content}
                      </pre>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full mt-2"
                        onClick={() => {
                          setContent(selectedVersion.content);
                          setChangelog(`Reverted to version ${selectedVersion.version}`);
                        }}
                      >
                        Restore this version
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
