import { useEffect, useState, useCallback } from "react";
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
import { Input } from "@/components/ui/input";
import {
  RefreshCcw,
  Database,
  Search,
  ChevronLeft,
  ChevronRight,
  Eye,
  CheckCircle2,
  AlertCircle,
  Send,
  GitCommit,
} from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProjectKey";
import { useAuth } from "@/hooks/useAuth";

interface LogEntry {
  id: string;
  projectId: string;
  taskId: string;
  providerMessageId?: string;
  templateId: string;
  workflowInstanceId: string | null;
  channel: string;
  attempt?: number;
  kind?: string;
  status: "pending" | "dispatched" | "delivered" | "failed" | "canceled" | "skipped";
  timestamp: string;
}

export default function LogsTable() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const [taskLifecycle, setTaskLifecycle] = useState<LogEntry[]>([]);
  const [loadingLifecycle, setLoadingLifecycle] = useState(false);

  const { projects, selectedProjectId, projectApiKey, isLoadingProjects } = useProject();
  const { apiUrl } = useAuth();

  const fetchLogs = useCallback(
    async (apiKey: string, projectId: string, cursor?: string | null) => {
      setIsLoading(true);
      try {
        const query = new URLSearchParams({ limit: "25" });
        if (cursor) query.set("cursor", cursor);
        if (search) query.set("search", search);
        if (channelFilter) query.set("channel", channelFilter);
        if (statusFilter) query.set("status", statusFilter);

        const res = await fetch(`${apiUrl}/v1/notifications/logs?${query.toString()}`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "x-project-id": projectId,
          },
        });

        if (!res.ok) {
          throw new Error(`Failed to fetch: ${res.statusText}`);
        }

        const data = await res.json();
        setLogs(data.logs || []);
        setNextCursor(data.nextCursor || null);
      } catch (err) {
        console.error(err);
        toast.error("Failed to fetch logs");
      } finally {
        setIsLoading(false);
      }
    },
    [apiUrl, search, channelFilter, statusFilter],
  );

  useEffect(() => {
    if (projectApiKey && selectedProjectId) {
      setCursorHistory([null]);
      setPageIndex(0);
      void fetchLogs(projectApiKey, selectedProjectId, null);
    } else {
      setLogs([]);
    }
  }, [projectApiKey, selectedProjectId, search, channelFilter, statusFilter, fetchLogs]);

  useEffect(() => {
    if (selectedLog && projectApiKey && selectedProjectId) {
      setLoadingLifecycle(true);
      fetch(`${apiUrl}/v1/notifications/${selectedLog.taskId}`, {
        headers: {
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && data.logs) {
            const sorted = [...data.logs].sort(
              (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
            );
            setTaskLifecycle(sorted);
          } else {
            setTaskLifecycle([selectedLog]);
          }
        })
        .catch(() => setTaskLifecycle([selectedLog]))
        .finally(() => setLoadingLifecycle(false));
    } else {
      setTaskLifecycle([]);
    }
  }, [apiUrl, selectedLog, projectApiKey, selectedProjectId]);

  const handleNextPage = () => {
    if (nextCursor && projectApiKey && selectedProjectId) {
      const newHistory = [...cursorHistory.slice(0, pageIndex + 1), nextCursor];
      setCursorHistory(newHistory);
      setPageIndex(pageIndex + 1);
      void fetchLogs(projectApiKey, selectedProjectId, nextCursor);
    }
  };

  const handlePrevPage = () => {
    if (pageIndex > 0 && projectApiKey && selectedProjectId) {
      const prevCursor = cursorHistory[pageIndex - 1] ?? null;
      setPageIndex(pageIndex - 1);
      void fetchLogs(projectApiKey, selectedProjectId, prevCursor);
    }
  };

  return (
    <Card className="h-full flex flex-col border-border bg-card">
      <CardHeader className="pb-3 border-b border-border space-y-3">
        <div className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-xl flex items-center gap-2">
              <Database className="h-5 w-5 text-foreground" />
              Historical Dispatches & Audit Logs
            </CardTitle>
            <CardDescription>
              Comprehensive notification audit trail with payload context
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              if (projectApiKey && selectedProjectId)
                void fetchLogs(projectApiKey, selectedProjectId, cursorHistory[pageIndex]);
            }}
            disabled={isLoading || !projectApiKey || !selectedProjectId}
            className="h-8 w-8 rounded-md border-border"
          >
            <RefreshCcw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {/* Filters and Search Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search Task ID or Template..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 text-xs font-mono"
            />
          </div>

          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            className="px-3 py-1.5 bg-background border border-input rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-ring text-foreground"
          >
            <option value="">All Channels</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="push">Push</option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 bg-background border border-input rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-ring text-foreground"
          >
            <option value="">All Statuses</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
            <option value="dispatched">Dispatched</option>
            <option value="pending">Pending</option>
          </select>
        </div>
      </CardHeader>

      <CardContent className="flex-1 p-0 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0">
            <TableRow>
              <TableHead className="font-medium">Timestamp</TableHead>
              <TableHead className="font-medium">Task ID</TableHead>
              <TableHead className="font-medium">Template</TableHead>
              <TableHead className="font-medium">Channel</TableHead>
              <TableHead className="font-medium">Status</TableHead>
              <TableHead className="font-medium text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoadingProjects ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  Loading projects...
                </TableCell>
              </TableRow>
            ) : projects.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No projects exist. Create one in Projects & Keys tab.
                </TableCell>
              </TableRow>
            ) : logs.length === 0 && !isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No log entries match your filter.
                </TableCell>
              </TableRow>
            ) : (
              Array.from(
                logs
                  .reduce((acc, log) => {
                    if (!acc.has(log.taskId)) {
                      acc.set(log.taskId, log);
                    } else {
                      const existing = acc.get(log.taskId)!;
                      if (existing.status === "dispatched" && log.status !== "dispatched") {
                        acc.set(log.taskId, log);
                      }
                    }
                    return acc;
                  }, new Map<string, LogEntry>())
                  .values(),
              ).map((log) => (
                <TableRow
                  key={log.id}
                  className="hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => setSelectedLog(log)}
                >
                  <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                    {new Date(log.timestamp).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs font-semibold text-foreground">
                    {log.taskId}
                  </TableCell>
                  <TableCell className="font-medium text-xs">{log.templateId}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="capitalize font-normal text-xs">
                      {log.channel}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={log.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
                      <Eye className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>

      {/* Pagination Footer */}
      <div className="p-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground bg-muted/20">
        <span>Page {pageIndex + 1}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrevPage}
            disabled={pageIndex === 0 || isLoading}
            className="h-7 text-xs border-border"
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNextPage}
            disabled={!nextCursor || isLoading}
            className="h-7 text-xs border-border"
          >
            Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      </div>

      {/* JSON Log Detail & Event Lifecycle Timeline Drawer */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-xl bg-card border-l border-border p-6 overflow-y-auto space-y-6">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <h2 className="text-lg font-bold text-foreground">Event Lifecycle & Detail</h2>
                <p className="text-xs text-muted-foreground font-mono">
                  Task ID: {selectedLog.taskId}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelectedLog(null)}>
                Close
              </Button>
            </div>

            {/* Complete Lifecycle Timeline */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <GitCommit className="h-4 w-4 text-foreground" />
                Notification Event Lifecycle
              </h3>

              {loadingLifecycle ? (
                <div className="p-4 rounded-lg bg-muted text-xs text-muted-foreground animate-pulse">
                  Loading complete event lifecycle logs...
                </div>
              ) : taskLifecycle.length === 0 ? (
                <div className="p-4 rounded-lg bg-muted text-xs text-muted-foreground">
                  No lifecycle history recorded.
                </div>
              ) : (
                <div className="relative pl-6 space-y-4 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-px before:bg-border">
                  {taskLifecycle.map((item) => {
                    const firstTime = new Date(taskLifecycle[0]!.timestamp).getTime();
                    const itemTime = new Date(item.timestamp).getTime();
                    const deltaMs = itemTime - firstTime;

                    return (
                      <div key={item.id} className="relative group">
                        <div className="absolute -left-6 top-0.5 h-5 w-5 rounded-full bg-background border border-border flex items-center justify-center">
                          {item.status === "delivered" ? (
                            <CheckCircle2 className="h-3 w-3 text-foreground" />
                          ) : item.status === "failed" ? (
                            <AlertCircle className="h-3 w-3 text-destructive" />
                          ) : (
                            <Send className="h-2.5 w-2.5 text-muted-foreground" />
                          )}
                        </div>

                        <div className="p-3 rounded-lg bg-muted/40 border border-border text-xs space-y-1.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <StatusBadge status={item.status} />
                              <span className="font-semibold capitalize text-foreground">
                                {item.kind === "attempt"
                                  ? `Attempt #${item.attempt || 1}`
                                  : item.kind}
                              </span>
                            </div>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {deltaMs > 0 ? `+${deltaMs}ms` : "Start"}
                            </span>
                          </div>

                          <div className="flex items-center justify-between text-muted-foreground text-[11px]">
                            <span>
                              Channel:{" "}
                              <strong className="text-foreground capitalize">{item.channel}</strong>
                            </span>
                            <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                          </div>

                          {item.providerMessageId && (
                            <div className="text-[11px] text-muted-foreground font-mono">
                              Provider Msg ID:{" "}
                              <span className="text-foreground">{item.providerMessageId}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Selected Record Details */}
            <div className="space-y-2 text-xs border-t border-border pt-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Selected Log Record Metadata
              </h3>
              <div className="grid grid-cols-2 gap-2 p-3 rounded-lg bg-muted/40 border border-border">
                <div>
                  <span className="text-muted-foreground">Log UUID:</span>
                  <div className="font-mono text-foreground truncate">{selectedLog.id}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Template ID:</span>
                  <div className="font-semibold text-foreground">{selectedLog.templateId}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Provider Message ID:</span>
                  <div className="font-mono text-foreground truncate">
                    {selectedLog.providerMessageId || "N/A"}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Workflow Instance:</span>
                  <div className="font-mono text-foreground truncate">
                    {selectedLog.workflowInstanceId || "Direct Send"}
                  </div>
                </div>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-muted-foreground">
                Full JSON Context
              </label>
              <pre className="mt-1 p-4 rounded-lg bg-muted border border-border text-xs font-mono overflow-x-auto text-foreground">
                {JSON.stringify(selectedLog, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ status }: { status: LogEntry["status"] }) {
  let variant: "default" | "secondary" | "destructive" | "outline" = "outline";

  switch (status) {
    case "delivered":
      variant = "default";
      break;
    case "failed":
      variant = "destructive";
      break;
    case "pending":
    case "dispatched":
      variant = "secondary";
      break;
    case "canceled":
    case "skipped":
      variant = "outline";
      break;
  }

  return (
    <Badge variant={variant} className="capitalize text-[10px] font-medium">
      {status}
    </Badge>
  );
}
