import { useEffect, useState, useCallback } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileCode2, RefreshCcw, Eye, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProjectKey";
import { useAuth } from "@/hooks/useAuth";

interface Template {
  id: string;
  projectId: string;
  channel: string;
  topics: string[];
  content: any;
  aiPrompts?: any;
  updatedAt: string;
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const { projectApiKey, selectedProjectId } = useProject();
  const { apiUrl } = useAuth();

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${apiUrl}/v1/templates`, {
        headers: {
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTemplates(data.templates || []);
    } catch (err: any) {
      console.error(err);
      toast.error("Failed to fetch templates");
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, projectApiKey, selectedProjectId]);

  useEffect(() => {
    if (projectApiKey && selectedProjectId) {
      void fetchTemplates();
    }
  }, [projectApiKey, selectedProjectId, fetchTemplates]);

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`${apiUrl}/v1/templates/${id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
      });
      if (!res.ok) throw new Error("Delete failed");
      toast.success(`Template ${id} deleted`);
      void fetchTemplates();
    } catch (_err: any) {
      toast.error("Failed to delete template");
    }
  };

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={true} />

      <main className="flex-1 container mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <FileCode2 className="h-6 w-6 text-foreground" />
              Template Directory & Channel Bindings
            </h1>
            <p className="text-muted-foreground text-sm">
              Registered notification templates, topic bindings, and AI prompts
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchTemplates()}
            disabled={isLoading}
          >
            <RefreshCcw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-lg">Notification Templates ({templates.length})</CardTitle>
            <CardDescription>Managed via PUT /v1/templates API endpoint</CardDescription>
          </CardHeader>
          <CardContent className="p-0 overflow-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Template ID</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Topics</TableHead>
                  <TableHead>Last Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      No templates synced for this project. Sync using initializeApp() or PUT
                      /v1/templates
                    </TableCell>
                  </TableRow>
                ) : (
                  templates.map((tpl) => (
                    <TableRow key={tpl.id} className="hover:bg-muted/50">
                      <TableCell className="font-mono text-sm font-bold text-foreground">
                        {tpl.id}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize font-normal text-xs">
                          {tpl.channel}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1 flex-wrap">
                          {(tpl.topics || []).map((t) => (
                            <Badge key={t} variant="outline" className="text-[10px]">
                              {t}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {new Date(tpl.updatedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => setSelectedTemplate(tpl)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:bg-destructive/10"
                          onClick={() => void handleDelete(tpl.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>

      {/* Template Preview Drawer */}
      {selectedTemplate && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-xl bg-card border-l border-border p-6 overflow-y-auto space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h2 className="text-lg font-bold text-foreground">Template: {selectedTemplate.id}</h2>
              <Button variant="ghost" size="sm" onClick={() => setSelectedTemplate(null)}>
                Close
              </Button>
            </div>
            <div className="space-y-2 text-xs">
              <div>
                <span className="text-muted-foreground">Channel:</span>{" "}
                <span className="font-semibold capitalize text-foreground">
                  {selectedTemplate.channel}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Topics:</span>{" "}
                <span className="font-mono text-foreground">
                  {(selectedTemplate.topics || []).join(", ")}
                </span>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">
                Template Content
              </label>
              <pre className="mt-1 p-4 rounded-md bg-muted border border-border text-xs font-mono overflow-x-auto text-foreground">
                {JSON.stringify(selectedTemplate.content, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
