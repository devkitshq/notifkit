"use client";

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

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
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
  }, [projectApiKey, selectedProjectId]);

  useEffect(() => {
    if (projectApiKey && selectedProjectId) {
      void fetchTemplates();
    }
  }, [projectApiKey, selectedProjectId, fetchTemplates]);

  const handleDelete = async (id: string) => {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
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
              <FileCode2 className="h-6 w-6 text-sky-400" />
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
            className="border-border/50 hover:bg-muted/50"
          >
            <RefreshCcw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <Card className="border-border/50 bg-card/40 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="text-lg">Notification Templates ({templates.length})</CardTitle>
            <CardDescription>Managed via PUT /v1/templates API endpoint</CardDescription>
          </CardHeader>
          <CardContent className="p-0 overflow-auto">
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow className="border-border/20">
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
                    <TableRow key={tpl.id} className="border-border/10 hover:bg-muted/20">
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
                            <Badge
                              key={t}
                              variant="outline"
                              className="text-[10px] border-sky-500/30 text-sky-400"
                            >
                              {t}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {new Date(tpl.updatedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right space-x-2">
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
                          className="h-8 w-8 text-rose-400 hover:bg-rose-500/10"
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
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-xl bg-card border-l border-border/40 p-6 overflow-y-auto space-y-4">
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <h2 className="text-lg font-bold">Template: {selectedTemplate.id}</h2>
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
                <span className="font-mono text-sky-400">
                  {(selectedTemplate.topics || []).join(", ")}
                </span>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">
                Template Content
              </label>
              <pre className="mt-1 p-4 rounded-lg bg-muted/30 border border-border/30 text-xs font-mono overflow-x-auto text-sky-300">
                {JSON.stringify(selectedTemplate.content, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
