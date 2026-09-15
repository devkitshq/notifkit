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
import { AlertTriangle, RefreshCcw, RotateCcw, Trash2, Eye } from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProjectKey";
import { useAuth } from "@/hooks/useAuth";

interface DLQMessage {
  id: string;
  eventType: string;
  payload: any;
  error: string;
  timestamp: string;
}

export default function DlqPage() {
  const [messages, setMessages] = useState<DLQMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedMessage, setSelectedMessage] = useState<DLQMessage | null>(null);
  const { projectApiKey, selectedProjectId } = useProject();
  const { apiUrl, token } = useAuth();

  const fetchDLQ = useCallback(async () => {
    const authKey = projectApiKey || token;
    if (!authKey) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${authKey}`,
      };
      if (selectedProjectId) {
        headers["x-project-id"] = selectedProjectId;
      }
      const res = await fetch(`${apiUrl}/v1/dlq`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMessages(data.messages || []);
    } catch (err: any) {
      console.error(err);
      toast.error("Failed to fetch Dead Letter Queue messages");
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, projectApiKey, selectedProjectId, token]);

  useEffect(() => {
    const authKey = projectApiKey || token;
    if (authKey) {
      void fetchDLQ();
    }
  }, [projectApiKey, token, fetchDLQ]);

  const handleReplay = async (id: string) => {
    const authKey = projectApiKey || token;
    if (!authKey) return;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authKey}`,
      };
      if (selectedProjectId) {
        headers["x-project-id"] = selectedProjectId;
      }
      const res = await fetch(`${apiUrl}/v1/dlq/replay`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error("Replay request failed");
      toast.success(`Message ${id} replayed into queue`);
      void fetchDLQ();
    } catch (_err: any) {
      toast.error("Failed to replay message");
    }
  };

  const handleDelete = async (id: string) => {
    const authKey = projectApiKey || token;
    if (!authKey) return;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${authKey}`,
      };
      if (selectedProjectId) {
        headers["x-project-id"] = selectedProjectId;
      }
      const res = await fetch(`${apiUrl}/v1/dlq/${id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error("Delete failed");
      toast.success(`Message ${id} purged from DLQ`);
      void fetchDLQ();
    } catch (_err: any) {
      toast.error("Failed to delete message");
    }
  };

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={true} />

      <main className="flex-1 container mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              Dead Letter Queue (DLQ) & Failure Diagnostics
            </h1>
            <p className="text-muted-foreground text-sm">
              Inspect undeliverable messages, review failure context, and execute stream replays
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void fetchDLQ()} disabled={isLoading}>
            <RefreshCcw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-lg">
              Poison & Failed Stream Messages ({messages.length})
            </CardTitle>
            <CardDescription>
              Messages routed to STREAMS.DEAD_LETTER after exhausting retry limits
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 overflow-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Stream Message ID</TableHead>
                  <TableHead>Event Type</TableHead>
                  <TableHead>Failure Reason</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {messages.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      No dead-letter messages found. Pipeline is operating smoothly!
                    </TableCell>
                  </TableRow>
                ) : (
                  messages.map((msg) => (
                    <TableRow key={msg.id} className="hover:bg-muted/50">
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {new Date(msg.timestamp).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-foreground font-medium">
                        {msg.id}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-mono text-[11px]">
                          {msg.eventType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-destructive text-xs truncate max-w-[250px] font-mono">
                        {msg.error}
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => setSelectedMessage(msg)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-foreground"
                          onClick={() => void handleReplay(msg.id)}
                          title="Replay Message"
                        >
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:bg-destructive/10"
                          onClick={() => void handleDelete(msg.id)}
                          title="Purge Message"
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

      {/* JSON Payload Inspection Drawer */}
      {selectedMessage && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-xl bg-card border-l border-border p-6 overflow-y-auto space-y-4 flex flex-col justify-between">
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <h2 className="text-lg font-bold text-foreground">DLQ Message Payload</h2>
                <Button variant="ghost" size="sm" onClick={() => setSelectedMessage(null)}>
                  Close
                </Button>
              </div>
              <div className="space-y-2 text-xs">
                <div>
                  <span className="text-muted-foreground">ID:</span>{" "}
                  <span className="font-mono text-foreground font-medium">
                    {selectedMessage.id}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Error:</span>{" "}
                  <span className="font-mono text-destructive">{selectedMessage.error}</span>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">
                  Raw Data Payload
                </label>
                <pre className="mt-1 p-4 rounded-md bg-muted border border-border text-xs font-mono overflow-x-auto text-foreground">
                  {JSON.stringify(selectedMessage.payload, null, 2)}
                </pre>
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-4 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void handleReplay(selectedMessage.id);
                  setSelectedMessage(null);
                }}
              >
                Replay Message
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
