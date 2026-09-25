import { useEffect, useState } from "react";
import { Activity, Bell, FolderKey, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useProject } from "@/hooks/useProjectKey";
import { useAuth } from "@/hooks/useAuth";

export default function DashboardHeader({ isConnected }: { isConnected: boolean }) {
  const { projects, selectedProjectId, setSelectedProjectId, projectApiKey } = useProject();
  const { apiUrl, token } = useAuth();
  const [highBackpressure, setHighBackpressure] = useState(false);

  useEffect(() => {
    const authKey = projectApiKey || token;
    if (!authKey) return;
    const checkMetrics = async () => {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${authKey}`,
        };
        if (selectedProjectId) {
          headers["x-project-id"] = selectedProjectId;
        }
        const res = await fetch(`${apiUrl}/v1/system/metrics`, { headers });
        if (res.ok) {
          const data = await res.json();
          const streams = data.streams || {};
          const maxDepth = Math.max(...(Object.values(streams) as number[]), 0);
          setHighBackpressure(maxDepth > 80000);
        }
      } catch {
        // Ignore background header check errors
      }
    };

    void checkMetrics();
    const interval = setInterval(() => void checkMetrics(), 10000);
    return () => clearInterval(interval);
  }, [apiUrl, projectApiKey, selectedProjectId, token]);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-foreground border border-border">
            <Bell className="h-4 w-4 text-foreground" />
          </div>
          Notifkit <span className="text-muted-foreground font-normal">Observability</span>
        </div>

        <div className="flex items-center gap-4">
          {highBackpressure && (
            <Badge variant="destructive" className="flex items-center gap-1.5 px-2.5 py-1 text-xs">
              <AlertTriangle className="h-3.5 w-3.5" />
              Queue Backpressure Warning (&gt;80% Cap)
            </Badge>
          )}

          {projects.length > 0 && (
            <div className="flex items-center gap-2">
              <FolderKey className="h-4 w-4 text-muted-foreground" />
              <select
                className="bg-muted border border-border text-sm rounded-md px-2.5 py-1.5 outline-none cursor-pointer text-foreground max-w-[200px] truncate"
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
            className="flex items-center gap-1.5 px-3 py-1"
          >
            <Activity className="h-3.5 w-3.5" />
            {isConnected ? "Live Stream Active" : "Disconnected"}
          </Badge>
        </div>
      </div>
    </header>
  );
}
