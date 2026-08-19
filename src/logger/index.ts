import pino, { type Logger as PinoLogger, type LoggerOptions as PinoOptions } from "pino";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export type Logger = PinoLogger;

export interface LoggerOptions {
  name: string;
  level?: LogLevel;
  pretty?: boolean;
  context?: Record<string, unknown>;
}

export function createLogger({ name, level = "info", pretty, context }: LoggerOptions): Logger {
  const usePretty = pretty ?? process.env["NODE_ENV"] !== "production";

  const options: PinoOptions = {
    name,
    level,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
    base: { service: name, ...context },
  };

  if (usePretty) {
    options.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
        messageFormat: "{service} | {msg}",
      },
    };
  }

  return pino(options);
}

export function withRequestId(logger: Logger, requestId: string): Logger {
  return logger.child({ requestId });
}

export function withContext(logger: Logger, context: Record<string, unknown>): Logger {
  return logger.child(context);
}

export function childLogger(logger: Logger, bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
