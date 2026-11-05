import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildStreamEvent, IngestEventSchema } from "@/contracts/index.js";
import { readJsonBody, sendJson, sendValidationError } from "../http.js";
import type { RouteContext } from "../router.js";
import { type Deps } from "./shared.js";

export function createEventsHandlers(deps: Deps) {
  const { logger } = deps;

  async function ingestEvent(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    const tsStr = req.headers["x-timestamp"];
    const expiryStr = req.headers["x-expiry"];

    if (tsStr && expiryStr) {
      const now = Date.now();
      const eventTime = new Date(tsStr as string).getTime();
      const expMs = parseInt(expiryStr as string, 10) * 1000;

      // An unreadable date would make every comparison false and let the event through.
      if (Number.isNaN(eventTime) || Number.isNaN(expMs)) {
        sendJson(res, 400, {
          error: "invalid_timestamp",
          message: "x-timestamp and x-expiry must be a date and a number of seconds",
        });
        return;
      }
      if (now > eventTime + expMs) {
        sendJson(res, 400, { error: "event_expired", message: "Webhook event is expired" });
        return;
      }
    }

    const parsed = IngestEventSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const eventId = randomUUID();
    const messageId = await deps.producers.events!.publish(
      buildStreamEvent(
        "event.received",
        {
          projectId: ctx.projectId!,
          eventName: parsed.data.name,
          payload: parsed.data.properties,
        },
        "api",
        eventId,
      ),
    );
    logger.info({ messageId, eventId, eventName: parsed.data.name }, "event received");
    sendJson(res, 202, { messageId, eventId });
  }

  async function getEventsStream(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> {
    let open = true;
    let stop: (() => void) | undefined;
    req.on("close", () => {
      open = false;
      stop?.();
    });

    const unlisten = await deps.liveEvents.listen((e) => {
      // Only events that name this project. One naming none belongs to no
      // tenant, so it goes to nobody rather than to everybody.
      if (!ctx.projectId || e.projectId !== ctx.projectId) return;
      res.write(`event: ${e.event}\n`);
      const data =
        e.event === "delivery:delivered"
          ? { taskId: e.taskId, providerMessageId: e.providerMessageId, channel: e.channel }
          : { taskId: e.taskId, error: e.error, channel: e.channel };
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    });
    if (!open) return unlisten();
    stop = unlisten;

    // Only once subscribed: a client that has the headers is already listening,
    // so whatever it triggers next cannot be missed.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 10000\n\n");
  }

  return {
    ingestEvent,
    getEventsStream,
  };
}
