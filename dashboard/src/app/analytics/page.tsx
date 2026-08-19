"use client";

import { useEffect, useState, useCallback } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BarChart3, RefreshCcw, CheckCircle2, XCircle, Activity, Layers } from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProjectKey";

interface MetricsData {
  streams: Record<string, number>;
  deliveryStats: {
    total: number;
    delivered: number;
    failed: number;
    successRate: number;
  };
}

export default function AnalyticsPage() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { projectApiKey, selectedProjectId } = useProject();

  const fetchMetrics = useCallback(async () => {
    setIsLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/v1/system/metrics`, {
        headers: {
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const metricsData = await res.json();
      setData(metricsData);
    } catch (err: any) {
      console.error(err);
      toast.error("Failed to fetch analytics & queue metrics");
    } finally {
      setIsLoading(false);
    }
  }, [projectApiKey, selectedProjectId]);

  useEffect(() => {
    if (projectApiKey && selectedProjectId) {
      void fetchMetrics();
      const interval = setInterval(() => void fetchMetrics(), 5000);
      return () => clearInterval(interval);
    }
  }, [projectApiKey, selectedProjectId, fetchMetrics]);

  const streamNames = [
    { key: "INBOUND_CRITICAL", label: "Inbound Critical Stream", color: "bg-rose-500" },
    { key: "INBOUND_NORMAL", label: "Inbound Normal Stream", color: "bg-blue-500" },
    { key: "INBOUND_LOW", label: "Inbound Low Stream", color: "bg-slate-500" },
    { key: "OUTBOUND_CRITICAL", label: "Outbound Critical Stream", color: "bg-emerald-500" },
    { key: "OUTBOUND_NORMAL", label: "Outbound Normal Stream", color: "bg-purple-500" },
    { key: "OUTBOUND_LOW", label: "Outbound Low Stream", color: "bg-amber-500" },
    { key: "WORKFLOW_INBOUND", label: "Workflow Inbound Stream", color: "bg-indigo-500" },
    { key: "EVENTS_INBOUND", label: "Events Inbound Stream", color: "bg-sky-500" },
  ];

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={true} />

      <main className="flex-1 container mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <BarChart3 className="h-6 w-6 text-purple-400" />
              Pipeline Analytics & Queue Depths
            </h1>
            <p className="text-muted-foreground text-sm">
              Delivery success rate SLA, dispatch throughput, and Redis stream queue depths
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchMetrics()}
            disabled={isLoading}
            className="border-border/50 hover:bg-muted/50"
          >
            <RefreshCcw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* High-level KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="border-border/50 bg-card/40 backdrop-blur-md">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Delivery Success Rate
              </CardTitle>
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-extrabold text-emerald-400">
                {data?.deliveryStats?.successRate ?? 100}%
              </div>
              <p className="text-xs text-muted-foreground mt-1">SLA Target &gt; 99.0%</p>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/40 backdrop-blur-md">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Dispatches
              </CardTitle>
              <Activity className="h-4 w-4 text-blue-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{data?.deliveryStats?.total ?? 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Processed across channels</p>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/40 backdrop-blur-md">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Delivered Messages
              </CardTitle>
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">
                {data?.deliveryStats?.delivered ?? 0}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Confirmed provider handoffs</p>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/40 backdrop-blur-md">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Permanent Failures
              </CardTitle>
              <XCircle className="h-4 w-4 text-rose-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-rose-400">
                {data?.deliveryStats?.failed ?? 0}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Routed to DLQ</p>
            </CardContent>
          </Card>
        </div>

        {/* Redis Streams Backlog Gauges */}
        <Card className="border-border/50 bg-card/40 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Layers className="h-5 w-5 text-indigo-400" />
              Stream Queue Depths & Backlog Meters
            </CardTitle>
            <CardDescription>Real-time item count inside Redis Streams</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {streamNames.map((st) => {
                const depth = data?.streams?.[st.key] ?? 0;
                const maxCapacity = 10000;
                const pct = Math.min(100, Math.round((depth / maxCapacity) * 100));

                return (
                  <div
                    key={st.key}
                    className="space-y-2 p-4 rounded-xl bg-muted/20 border border-border/30"
                  >
                    <div className="flex justify-between items-center text-sm">
                      <span className="font-semibold text-foreground">{st.label}</span>
                      <span className="font-mono text-xs font-bold text-muted-foreground">
                        {depth} items
                      </span>
                    </div>
                    <div className="w-full h-3 rounded-full bg-muted overflow-hidden relative">
                      <div
                        className={`h-full transition-all duration-500 ${st.color}`}
                        style={{ width: `${Math.max(4, pct)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>0</span>
                      <span>Cap: 10,000</span>
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
