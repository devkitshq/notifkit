import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CheckCircle2, XCircle, Clock, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProjectKey";
import { useAuth } from "@/hooks/useAuth";

interface DeliveryEvent {
  id: string;
  type: "delivered" | "failed";
  taskId: string;
  channel: string;
  error?: string;
  providerMessageId?: string;
  timestamp: Date;
}

export default function RealTimeFeed({
  setIsConnected,
}: {
  setIsConnected: (status: boolean) => void;
}) {
  const [events, setEvents] = useState<DeliveryEvent[]>([]);
  const { projects, selectedProjectId, projectApiKey, isLoadingProjects } = useProject();
  const { apiUrl } = useAuth();

  useEffect(() => {
    if (!projectApiKey || !selectedProjectId) return;
    setIsConnected(false);

    const es = new EventSource(
      `${apiUrl}/v1/events/stream?token=${encodeURIComponent(projectApiKey)}&projectId=${encodeURIComponent(selectedProjectId)}`,
    );

    es.onopen = () => {
      setIsConnected(true);
      toast.success("Connected to real-time feed");
    };

    es.onerror = () => {
      setIsConnected(false);
    };

    const handleDelivered = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const newEvent: DeliveryEvent = {
          id: crypto.randomUUID(),
          type: "delivered",
          taskId: data.taskId,
          channel: data.channel,
          providerMessageId: data.providerMessageId,
          timestamp: new Date(),
        };
        setEvents((prev) => [newEvent, ...prev].slice(0, 100));
      } catch (err) {
        console.error("Failed to parse delivered event", err);
      }
    };

    const handleFailed = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const newEvent: DeliveryEvent = {
          id: crypto.randomUUID(),
          type: "failed",
          taskId: data.taskId,
          channel: data.channel,
          error: data.error,
          timestamp: new Date(),
        };
        setEvents((prev) => [newEvent, ...prev].slice(0, 100));
      } catch (err) {
        console.error("Failed to parse failed event", err);
      }
    };

    es.addEventListener("delivery:delivered", handleDelivered);
    es.addEventListener("delivery:failed", handleFailed);

    return () => {
      es.removeEventListener("delivery:delivered", handleDelivered);
      es.removeEventListener("delivery:failed", handleFailed);
      es.close();
    };
  }, [apiUrl, projectApiKey, selectedProjectId, setIsConnected]);

  return (
    <Card className="h-full flex flex-col border-border bg-card">
      <CardHeader className="pb-3 border-b border-border flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-xl flex items-center gap-2">
            <ActivityPulse />
            Live Activity Feed
          </CardTitle>
          <CardDescription>
            Real-time delivery events from the notification pipeline
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 text-sm bg-muted p-1.5 rounded-md border border-border px-3">
          <Settings2 className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">Instant Stream</span>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-0 overflow-hidden">
        <ScrollArea className="h-full min-h-[500px] w-full px-6 py-4">
          {isLoadingProjects ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
              <Clock className="h-8 w-8 opacity-50" />
              <p className="text-sm">Loading projects...</p>
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
              <Clock className="h-8 w-8 opacity-50" />
              <p className="text-sm">No projects exist. Create one in the Projects & Keys tab.</p>
            </div>
          ) : !projectApiKey ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
              <Clock className="h-8 w-8 opacity-50" />
              <p className="text-sm">No API key found for this project.</p>
            </div>
          ) : events.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
              <Clock className="h-8 w-8 opacity-50" />
              <p className="text-sm">Waiting for events...</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {events.map((event) => (
                <div
                  key={event.id}
                  className="rounded-lg border border-border p-4 bg-card hover:bg-muted/50 transition-colors shadow-xs"
                >
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                      {event.type === "delivered" ? (
                        <CheckCircle2 className="h-4 w-4 text-foreground" />
                      ) : (
                        <XCircle className="h-4 w-4 text-destructive" />
                      )}
                      <span className="font-semibold text-sm capitalize">{event.type}</span>
                    </div>
                    <span className="text-xs text-muted-foreground font-mono">
                      {event.timestamp.toLocaleTimeString()}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-sm mt-3">
                    <div className="flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        Channel
                      </span>
                      <Badge
                        variant="secondary"
                        className="w-fit mt-1 text-xs capitalize font-normal"
                      >
                        {event.channel}
                      </Badge>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        Task ID
                      </span>
                      <span className="font-mono text-xs truncate mt-1 text-foreground">
                        {event.taskId}
                      </span>
                    </div>
                  </div>

                  {event.error && (
                    <div className="mt-3 text-xs bg-destructive/10 text-destructive p-2.5 rounded-md border border-destructive/20 font-mono">
                      {event.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function ActivityPulse() {
  return (
    <div className="relative flex h-2.5 w-2.5">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
    </div>
  );
}
