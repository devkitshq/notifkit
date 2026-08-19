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
import { Clock, RefreshCcw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProjectKey";

interface ScheduledItem {
  taskId: string;
  payload: any;
  createdAt: string;
}

export default function ScheduledMessagesPage() {
  const [items, setItems] = useState<ScheduledItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { projectApiKey, selectedProjectId } = useProject();

  const fetchScheduled = useCallback(async () => {
    setIsLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/v1/notifications/scheduled`, {
        headers: {
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.scheduled || []);
    } catch (err: any) {
      console.error(err);
      toast.error("Failed to fetch scheduled notifications");
    } finally {
      setIsLoading(false);
    }
  }, [projectApiKey, selectedProjectId]);

  useEffect(() => {
    if (projectApiKey && selectedProjectId) {
      void fetchScheduled();
    }
  }, [projectApiKey, selectedProjectId, fetchScheduled]);

  const handleCancel = async (taskId: string) => {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/v1/notifications/${taskId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
      });
      if (!res.ok) throw new Error("Cancel failed");
      toast.success(`Task ${taskId} canceled`);
      void fetchScheduled();
    } catch (_err: any) {
      toast.error("Failed to cancel scheduled task");
    }
  };

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={true} />

      <main className="flex-1 container mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Clock className="h-6 w-6 text-amber-400" />
              Scheduled & Deferred Notification Pipeline
            </h1>
            <p className="text-muted-foreground text-sm">
              Notifications queued for future timestamps or deferred due to recipient quiet hours
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchScheduled()}
            disabled={isLoading}
            className="border-border/50 hover:bg-muted/50"
          >
            <RefreshCcw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <Card className="border-border/50 bg-card/40 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="text-lg">Pending Scheduled Messages ({items.length})</CardTitle>
            <CardDescription>
              Managed via Redis Sorted Sets (ZSET) and persistent storage
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 overflow-auto">
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow className="border-border/20">
                  <TableHead>Created At</TableHead>
                  <TableHead>Task ID</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Scheduled Send At</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                      No pending scheduled or deferred messages found.
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item) => {
                    const sendAt = item.payload?.scheduledAt;
                    const recipientId =
                      item.payload?.recipientId ||
                      item.payload?.recipient?.id ||
                      (typeof item.payload?.target === "object"
                        ? JSON.stringify(item.payload?.target)
                        : String(item.payload?.target || "N/A"));
                    return (
                      <TableRow key={item.taskId} className="border-border/10 hover:bg-muted/20">
                        <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                          {new Date(item.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell
                          className="font-mono text-xs font-semibold text-foreground max-w-[180px] truncate"
                          title={item.taskId}
                        >
                          {item.taskId}
                        </TableCell>
                        <TableCell className="font-medium text-xs">
                          {item.payload?.templateId || item.payload?.template || "N/A"}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[150px]">
                          {recipientId}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className="font-mono text-[11px] border-amber-500/30 text-amber-400"
                          >
                            {sendAt ? new Date(sendAt).toLocaleString() : "Pending Dispatch"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-rose-400 hover:bg-rose-500/10"
                            onClick={() => void handleCancel(item.taskId)}
                          >
                            <XCircle className="h-4 w-4 mr-1" />
                            Cancel Task
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
