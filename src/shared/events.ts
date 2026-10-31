import { EventEmitter } from "node:events";

export const globalEmitter = new EventEmitter();
// Listeners: each NotifkitServer's event forwarding (src/server.ts) and
// delivery's live-event publisher. Several servers in one process (tests)
// can pass the default limit without leaking.
globalEmitter.setMaxListeners(0);
