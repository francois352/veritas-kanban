import { useState, useEffect } from 'react';
import { PromptTemplate } from '@veritas-kanban/shared';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { Button } from '../components/ui/button';
import { useToast } from '../hooks/useToast';
import { TemplateList } from '../components/templates/template-list';
import { TemplateEditor } from '../components/templates/template-editor';

interface TemplatesPageProps {
  onBack: () => void;
}

export function TemplatesPage({ onBack }: TemplatesPageProps) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplate | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  const fetchTemplates = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/v1/prompt-templates');
      if (!res.ok) throw new Error('Failed to fetch templates');
      const json = await res.json();
      setTemplates(json.data || json);
    } catch (err) {
      toast({
        title: 'Error',
        description: 'Failed to load prompt templates',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const handleSave = async (data: Partial<PromptTemplate> & { changelog?: string }) => {
    try {
      const isUpdate = !!selectedTemplate?.id;
      const url = isUpdate
        ? `/api/v1/prompt-templates/${selectedTemplate.id}`
        : '/api/v1/prompt-templates';
      const method = isUpdate ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        throw new Error('Failed to save template');
      }

      toast({
        title: 'Success',
        description: `Template ${isUpdate ? 'updated' : 'created'} successfully`,
      });

      await fetchTemplates();
      setIsEditing(false);
      setSelectedTemplate(null);
    } catch (err) {
      toast({
        title: 'Error',
        description: 'Failed to save template',
        variant: 'destructive',
      });
    }
  };

  const handleRender = async (templateId: string, variables: Record<string, string>): Promise<string> => {
    const res = await fetch(`/api/v1/prompt-templates/${templateId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables }),
    });

    if (!res.ok) {
      throw new Error('Failed to render template');
    }

    const json = await res.json();
    return json.data?.rendered || json.rendered;
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] gap-4">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4 rounded-lg shadow-sm flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to board">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Prompt Templates
            </h1>
            <p className="text-sm text-muted-foreground">
              Manage reusable prompt templates with version control
            </p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground">Loading templates...</p>
          </div>
        ) : isEditing ? (
          <TemplateEditor
            template={selectedTemplate}
            onSave={handleSave}
            onCancel={() => {
              setIsEditing(false);
              setSelectedTemplate(null);
            }}
            onRender={handleRender}
          />
        ) : (
          <TemplateList
            templates={templates}
            onSelect={(template) => {
              setSelectedTemplate(template);
              setIsEditing(true);
            }}
            onCreateNew={() => {
              setSelectedTemplate(null);
              setIsEditing(true);
            }}
          />
        )}
      </div>
    </div>
  );
}
