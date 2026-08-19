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
import { GitFork, RefreshCcw, Play, Search, Eye, Layers } from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProjectKey";

interface WorkflowDef {
  id: string;
  name: string;
  steps: any[];
  createdAt: string;
}

interface WorkflowInstance {
  id: string;
  projectId: string;
  workflowName: string;
  status: "pending" | "running" | "completed" | "failed";
  currentStepIndex: number;
  input: any;
  output: any;
  createdAt: string;
  updatedAt: string;
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowDef | null>(null);

  const [instanceSearchId, setInstanceSearchId] = useState("");
  const [searchedInstance, setSearchedInstance] = useState<WorkflowInstance | null>(null);
  const [searchingInstance, setSearchingInstance] = useState(false);

  const { projectApiKey, selectedProjectId } = useProject();

  const fetchWorkflows = useCallback(async () => {
    setIsLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/v1/workflows`, {
        headers: {
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setWorkflows(data.workflows || []);
    } catch (err: any) {
      console.error(err);
      toast.error("Failed to fetch workflows");
    } finally {
      setIsLoading(false);
    }
  }, [projectApiKey, selectedProjectId]);

  useEffect(() => {
    if (projectApiKey && selectedProjectId) {
      void fetchWorkflows();
    }
  }, [projectApiKey, selectedProjectId, fetchWorkflows]);

  const handleTrigger = async (name: string) => {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/v1/workflows/trigger`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
        body: JSON.stringify({ name, input: {} }),
      });
      if (!res.ok) throw new Error("Trigger failed");
      const data = await res.json();
      toast.success(`Workflow "${name}" triggered! Instance ID: ${data.instanceId}`);
      if (data.instanceId) {
        setInstanceSearchId(data.instanceId);
        void handleSearchInstance(data.instanceId);
      }
    } catch (_err: any) {
      toast.error("Failed to trigger workflow");
    }
  };

  const handleSearchInstance = async (idToSearch?: string) => {
    const targetId = idToSearch || instanceSearchId.trim();
    if (!targetId) return;
    setSearchingInstance(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/v1/workflows/instances/${encodeURIComponent(targetId)}`, {
        headers: {
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
      });
      if (!res.ok) throw new Error("Instance not found");
      const data = await res.json();
      setSearchedInstance(data);
    } catch {
      toast.error("Workflow instance not found");
      setSearchedInstance(null);
    } finally {
      setSearchingInstance(false);
    }
  };

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={true} />

      <main className="flex-1 container mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <GitFork className="h-6 w-6 text-indigo-400" />
              Workflows & Event Orchestration
            </h1>
            <p className="text-muted-foreground text-sm">
              Multi-step notification orchestration definitions, step execution history, and
              instance tracing
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchWorkflows()}
            disabled={isLoading}
            className="border-border/50 hover:bg-muted/50"
          >
            <RefreshCcw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Workflow Instance Tracing Search */}
        <Card className="border-border/50 bg-card/40 backdrop-blur-md">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-indigo-400">
              <Search className="h-4 w-4" />
              Workflow Instance Lookup & Step Execution Visualizer
            </CardTitle>
            <CardDescription className="text-xs">
              Search by instance UUID to view step-by-step execution state and payload progress
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2 max-w-lg">
              <input
                type="text"
                placeholder="Enter Workflow Instance ID..."
                value={instanceSearchId}
                onChange={(e) => setInstanceSearchId(e.target.value)}
                className="flex-1 px-3 py-1.5 bg-muted/30 border border-border/40 rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <Button
                variant="secondary"
                size="sm"
                className="text-xs"
                onClick={() => void handleSearchInstance()}
                disabled={searchingInstance}
              >
                {searchingInstance ? "Searching..." : "Trace Instance"}
              </Button>
            </div>

            {searchedInstance && (
              <div className="p-4 rounded-xl bg-muted/20 border border-border/30 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <div>
                    <span className="text-muted-foreground">Instance ID:</span>{" "}
                    <span className="font-mono text-foreground font-bold">
                      {searchedInstance.id}
                    </span>
                  </div>
                  <Badge
                    variant={searchedInstance.status === "completed" ? "default" : "secondary"}
                    className="capitalize"
                  >
                    {searchedInstance.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  Workflow Name:{" "}
                  <strong className="text-foreground">{searchedInstance.workflowName}</strong> |
                  Step Pointer:{" "}
                  <strong className="text-foreground">
                    {searchedInstance.currentStepIndex ?? 0}
                  </strong>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Registered Workflows Grid / Table */}
        <Card className="border-border/50 bg-card/40 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="text-lg">Registered Workflows ({workflows.length})</CardTitle>
            <CardDescription>Definitions registered for background execution</CardDescription>
          </CardHeader>
          <CardContent className="p-0 overflow-auto">
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow className="border-border/20">
                  <TableHead>Created At</TableHead>
                  <TableHead>Workflow Name</TableHead>
                  <TableHead>Steps Count</TableHead>
                  <TableHead>Definition Structure</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      No registered workflows found. Register workflows using POST /v1/workflows
                    </TableCell>
                  </TableRow>
                ) : (
                  workflows.map((wf) => (
                    <TableRow key={wf.id} className="border-border/10 hover:bg-muted/20">
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {new Date(wf.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-bold text-sm font-mono text-foreground">
                        {wf.name}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-mono text-[11px]">
                          {Array.isArray(wf.steps) ? wf.steps.length : 0} steps
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[300px]">
                        {JSON.stringify(wf.steps)}
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-muted-foreground hover:text-foreground"
                          onClick={() => setSelectedWorkflow(wf)}
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          View Diagram
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10"
                          onClick={() => void handleTrigger(wf.name)}
                        >
                          <Play className="h-3.5 w-3.5 mr-1" />
                          Trigger Now
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

      {/* Visual Step Execution Graph Modal */}
      {selectedWorkflow && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-xl bg-card border-l border-border/40 p-6 overflow-y-auto space-y-6">
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <div>
                <h2 className="text-lg font-bold">Workflow Diagram: {selectedWorkflow.name}</h2>
                <p className="text-xs text-muted-foreground font-mono">ID: {selectedWorkflow.id}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelectedWorkflow(null)}>
                Close
              </Button>
            </div>

            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="h-4 w-4 text-indigo-400" />
                Execution Step Graph Flow
              </h3>

              <div className="space-y-3 relative pl-4 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-indigo-500/30">
                {(selectedWorkflow.steps || []).map((step: any, idx: number) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg bg-muted/20 border border-border/30 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between font-bold">
                      <span className="text-indigo-400">
                        Step {idx + 1}: {step.type || step.name || "Action"}
                      </span>
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {step.channel || step.action || "Step Node"}
                      </Badge>
                    </div>
                    <pre className="text-[11px] text-muted-foreground overflow-x-auto font-mono">
                      {JSON.stringify(step, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
