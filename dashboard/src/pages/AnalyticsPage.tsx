import { useEffect, useState, useCallback } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BarChart3, RefreshCcw, CheckCircle2, XCircle, Activity, Layers } from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProjectKey";
import { useAuth } from "@/hooks/useAuth";

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
  const { apiUrl, token } = useAuth();

  const fetchMetrics = useCallback(async () => {
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
      const res = await fetch(`${apiUrl}/v1/system/metrics`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const metricsData = await res.json();
      setData(metricsData);
    } catch (err: any) {
      console.error(err);
      toast.error("Failed to fetch analytics & queue metrics");
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, projectApiKey, selectedProjectId, token]);

  useEffect(() => {
    const authKey = projectApiKey || token;
    if (authKey) {
      void fetchMetrics();
      const interval = setInterval(() => void fetchMetrics(), 5000);
      return () => clearInterval(interval);
    }
  }, [projectApiKey, token, fetchMetrics]);

  const streamNames = [
    { key: "INBOUND_CRITICAL", label: "Inbound Critical Stream" },
    { key: "INBOUND_NORMAL", label: "Inbound Normal Stream" },
    { key: "INBOUND_LOW", label: "Inbound Low Stream" },
    { key: "OUTBOUND_CRITICAL", label: "Outbound Critical Stream" },
    { key: "OUTBOUND_NORMAL", label: "Outbound Normal Stream" },
    { key: "OUTBOUND_LOW", label: "Outbound Low Stream" },
    { key: "WORKFLOW_INBOUND", label: "Workflow Inbound Stream" },
    { key: "EVENTS_INBOUND", label: "Events Inbound Stream" },
  ];

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={true} />

      <main className="flex-1 container mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <BarChart3 className="h-6 w-6 text-foreground" />
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
          >
            <RefreshCcw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* High-level KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="border-border bg-card">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Delivery Success Rate
              </CardTitle>
              <CheckCircle2 className="h-4 w-4 text-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">
                {data?.deliveryStats?.successRate ?? 100}%
              </div>
              <p className="text-xs text-muted-foreground mt-1">SLA Target &gt; 99.0%</p>
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Dispatches
              </CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{data?.deliveryStats?.total ?? 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Processed across channels</p>
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Delivered Messages
              </CardTitle>
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">
                {data?.deliveryStats?.delivered ?? 0}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Confirmed provider handoffs</p>
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Permanent Failures
              </CardTitle>
              <XCircle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-destructive">
                {data?.deliveryStats?.failed ?? 0}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Routed to DLQ</p>
            </CardContent>
          </Card>
        </div>

        {/* Redis Streams Backlog Gauges */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Layers className="h-5 w-5 text-foreground" />
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
                    className="space-y-2 p-4 rounded-lg bg-muted/40 border border-border"
                  >
                    <div className="flex justify-between items-center text-sm">
                      <span className="font-semibold text-foreground">{st.label}</span>
                      <span className="font-mono text-xs font-bold text-muted-foreground">
                        {depth} items
                      </span>
                    </div>
                    <div className="w-full h-2.5 rounded-full bg-muted overflow-hidden relative">
                      <div
                        className="h-full bg-primary transition-all duration-300 rounded-full"
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
