"use client";

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
} from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProjectKey";

interface WorkerHealth {
  state?: string;
  status?: string;
  redis?: boolean;
  activeTasks?: number;
  lastHeartbeat?: number;
  error?: string;
}

interface SystemHealthData {
  status: "healthy" | "degraded" | "down";
  redis: { ok: boolean; latencyMs: number };
  db: { ok: boolean; latencyMs: number };
  workers: Record<string, WorkerHealth>;
}

export default function SystemHealthPage() {
  const [data, setData] = useState<SystemHealthData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { projectApiKey, selectedProjectId } = useProject();

  const fetchHealth = useCallback(async () => {
    setIsLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/v1/system/health`, {
        headers: {
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const healthData = await res.json();
      setData(healthData);
    } catch (err: any) {
      console.error(err);
      toast.error("Failed to fetch system health");
    } finally {
      setIsLoading(false);
    }
  }, [projectApiKey, selectedProjectId]);

  useEffect(() => {
    if (projectApiKey && selectedProjectId) {
      void fetchHealth();
      const interval = setInterval(() => void fetchHealth(), 5000);
      return () => clearInterval(interval);
    }
  }, [projectApiKey, selectedProjectId, fetchHealth]);

  const workerNames = ["enricher", "engine", "scheduler", "delivery", "ai", "workflow", "events"];

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={data?.status === "healthy"} />

      <main className="flex-1 container mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <HeartPulse className="h-6 w-6 text-emerald-400" />
              System Infrastructure & Worker Health
            </h1>
            <p className="text-muted-foreground text-sm">
              Real-time heartbeats, database/Redis latencies, and microservice status
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchHealth()}
            disabled={isLoading}
            className="border-border/50 hover:bg-muted/50"
          >
            <RefreshCcw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Top KPI Cards: Redis & DB latency */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-border/50 bg-card/40 backdrop-blur-md">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Redis Connection
              </CardTitle>
              <Server className="h-4 w-4 text-rose-400" />
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold">{data?.redis?.latencyMs ?? 0} ms</span>
                <Badge variant={data?.redis?.ok ? "default" : "destructive"}>
                  {data?.redis?.ok ? "Connected" : "Disconnected"}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/40 backdrop-blur-md">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                PostgreSQL Database
              </CardTitle>
              <Database className="h-4 w-4 text-blue-400" />
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold">{data?.db?.latencyMs ?? 0} ms</span>
                <Badge variant={data?.db?.ok ? "default" : "destructive"}>
                  {data?.db?.ok ? "Healthy" : "Unreachable"}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/40 backdrop-blur-md">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Overall Cluster State
              </CardTitle>
              <Cpu className="h-4 w-4 text-purple-400" />
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold capitalize">{data?.status ?? "Unknown"}</span>
                <StatusIcon status={data?.status} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Worker Microservices Grid */}
        <Card className="border-border/50 bg-card/40 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="text-lg">Worker Heartbeats & Concurrency</CardTitle>
            <CardDescription>Monitored active workers in the event pipeline</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {workerNames.map((wName) => {
                const wInfo = data?.workers?.[wName];
                const isAlive = wInfo && wInfo.status !== "error" && wInfo.status !== "unknown";

                return (
                  <div
                    key={wName}
                    className="p-4 rounded-xl border border-border/30 bg-muted/20 flex flex-col justify-between space-y-3 hover:border-border/60 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm capitalize">{wName} Worker</span>
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          isAlive ? "bg-emerald-500 shadow-[0_0_8px_#10b981]" : "bg-rose-500"
                        }`}
                      />
                    </div>

                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div className="flex justify-between">
                        <span>Status:</span>
                        <span className="font-medium text-foreground capitalize">
                          {wInfo?.state || wInfo?.status || "Idle / Standing By"}
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
  if (status === "healthy") return <CheckCircle2 className="h-6 w-6 text-emerald-400" />;
  if (status === "degraded") return <AlertCircle className="h-6 w-6 text-amber-400" />;
  return <XCircle className="h-6 w-6 text-rose-400" />;
}
