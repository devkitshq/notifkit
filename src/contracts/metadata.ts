import { z } from "zod";

export const EventMetadataSchema = z.object({
  traceId: z.string(),
  source: z.string(),
  retryCount: z.number().int().nonnegative().default(0),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
});
export type EventMetadata = z.infer<typeof EventMetadataSchema>;
