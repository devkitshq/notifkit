import { useEffect, useState, useCallback } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  HeartPulse,
  Database,
  Server,
  Cpu,
  RefreshCcw,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProjectKey";
import { useAuth } from "@/hooks/useAuth";

interface WorkerHealth {
  service?: string;
  state?: string;
  status?: string;
  redis?: boolean;
  activeTasks?: number;
  lastHeartbeat?: number;
  updatedAt?: string;
  error?: string;
  message?: string;
}

interface SystemHealthData {
  status: "healthy" | "degraded" | "down";
  redis: { ok: boolean; latencyMs: number };
  db: { ok: boolean; latencyMs: number };
  workers: Record<string, WorkerHealth>;
}

export default function SystemPage() {
  const [data, setData] = useState<SystemHealthData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { projectApiKey, selectedProjectId } = useProject();
  const { apiUrl, token } = useAuth();

  const fetchHealth = useCallback(async () => {
    const authKey = projectApiKey || token;
    if (!authKey) {
      setIsLoading(false);
      return;
    }

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${authKey}`,
      };
      if (selectedProjectId) {
        headers["x-project-id"] = selectedProjectId;
      }
      const res = await fetch(`${apiUrl}/v1/system/health`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const healthData = await res.json();
      setData(healthData);
    } catch (err: any) {
      console.error(err);
      toast.error("Failed to fetch system health");
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, projectApiKey, selectedProjectId, token]);

  useEffect(() => {
    const authKey = projectApiKey || token;
    if (authKey) {
      void fetchHealth();
      const interval = setInterval(() => void fetchHealth(), 5000);
      return () => clearInterval(interval);
    }
  }, [projectApiKey, token, fetchHealth]);

  const workerNames = ["enricher", "engine", "scheduler", "delivery", "ai", "workflow", "events"];

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={data?.status === "healthy"} />

      <main className="flex-1 container mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <HeartPulse className="h-6 w-6 text-foreground" />
              System Infrastructure & Worker Health
            </h1>
            <p className="text-muted-foreground text-sm">
              Real-time heartbeats, database/Redis latencies, and microservice status
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setIsLoading(true);
              void fetchHealth();
            }}
            disabled={isLoading}
          >
            <RefreshCcw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Top KPI Cards: Redis & DB latency */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-border bg-card">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Redis Connection
              </CardTitle>
              <Server className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoading && !data ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking...
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-2xl font-bold">{data?.redis?.latencyMs ?? 0} ms</span>
                  <Badge variant={data?.redis?.ok ? "default" : "destructive"}>
                    {data?.redis?.ok ? "Connected" : "Disconnected"}
                  </Badge>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                PostgreSQL Database
              </CardTitle>
              <Database className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoading && !data ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking...
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-2xl font-bold">{data?.db?.latencyMs ?? 0} ms</span>
                  <Badge variant={data?.db?.ok ? "default" : "destructive"}>
                    {data?.db?.ok ? "Healthy" : "Unreachable"}
                  </Badge>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Overall Cluster State
              </CardTitle>
              <Cpu className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoading && !data ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking...
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-2xl font-bold capitalize">
                    {data?.status ?? "Checking"}
                  </span>
                  <StatusIcon status={data?.status} />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Worker Microservices Grid */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-lg">Worker Heartbeats & Concurrency</CardTitle>
            <CardDescription>Monitored active workers in the event pipeline</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {workerNames.map((wName) => {
                const wInfo = data?.workers?.[wName];
                const isAlive = Boolean(
                  wInfo &&
                  wInfo.status !== "error" &&
                  wInfo.status !== "unknown" &&
                  (wInfo.redis !== false ||
                    wInfo.status === "active" ||
                    wInfo.status === "healthy" ||
                    wInfo.state),
                );

                const displayState =
                  wInfo?.state ||
                  (wInfo?.status && wInfo.status !== "unknown" ? wInfo.status : null) ||
                  (wInfo?.redis ? "Active" : "Idle / Standby");

                return (
                  <div
                    key={wName}
                    className="p-4 rounded-lg border border-border bg-muted/40 flex flex-col justify-between space-y-3 hover:border-border transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm capitalize">{wName} Worker</span>
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          isAlive ? "bg-foreground" : "bg-muted-foreground/40"
                        }`}
                      />
                    </div>

                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div className="flex justify-between">
                        <span>Status:</span>
                        <span className="font-medium text-foreground capitalize">
                          {displayState}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Active Concurrency:</span>
                        <span className="font-mono text-foreground font-semibold">
                          {wInfo?.activeTasks ?? 0} tasks
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function StatusIcon({ status }: { status?: string }) {
  if (status === "healthy") return <CheckCircle2 className="h-5 w-5 text-foreground" />;
  if (status === "degraded") return <AlertCircle className="h-5 w-5 text-muted-foreground" />;
  return <XCircle className="h-5 w-5 text-destructive" />;
}
