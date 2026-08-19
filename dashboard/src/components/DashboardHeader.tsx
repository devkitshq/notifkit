"use client";

import { useEffect, useState } from "react";
import { Activity, Bell, FolderKey, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useProject } from "@/hooks/useProjectKey";

export default function DashboardHeader({ isConnected }: { isConnected: boolean }) {
  const { projects, selectedProjectId, setSelectedProjectId, projectApiKey } = useProject();
  const [highBackpressure, setHighBackpressure] = useState(false);

  useEffect(() => {
    if (!projectApiKey || !selectedProjectId) return;
    const checkMetrics = async () => {
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
        const res = await fetch(`${apiUrl}/v1/system/metrics`, {
          headers: {
            Authorization: `Bearer ${projectApiKey}`,
            "x-project-id": selectedProjectId,
          },
        });
        if (res.ok) {
          const data = await res.json();
          const streams = data.streams || {};
          const maxDepth = Math.max(...(Object.values(streams) as number[]), 0);
          setHighBackpressure(maxDepth > 8000);
        }
      } catch {
        // Ignore background header check errors
      }
    };

    void checkMetrics();
    const interval = setInterval(() => void checkMetrics(), 10000);
    return () => clearInterval(interval);
  }, [projectApiKey, selectedProjectId]);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Bell className="h-5 w-5 text-primary" />
          </div>
          Notifkit <span className="text-muted-foreground font-normal">Observability</span>
        </div>

        <div className="flex items-center gap-4">
          {highBackpressure && (
            <Badge
              variant="destructive"
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs animate-bounce"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Queue Backpressure Warning (&gt;80% Cap)
            </Badge>
          )}

          {projects.length > 0 && (
            <div className="flex items-center gap-2">
              <FolderKey className="h-4 w-4 text-muted-foreground" />
              <select
                className="bg-muted/50 border border-border/50 text-sm rounded-lg p-1.5 outline-none cursor-pointer text-foreground max-w-[200px] truncate"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <Badge
            variant={isConnected ? "default" : "destructive"}
            className="flex items-center gap-1.5 px-3 py-1 shadow-sm transition-all"
          >
            {isConnected ? (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
            ) : (
              <Activity className="h-3.5 w-3.5" />
            )}
            {isConnected ? "Live Stream Active" : "Disconnected"}
          </Badge>
        </div>
      </div>
    </header>
  );
}
