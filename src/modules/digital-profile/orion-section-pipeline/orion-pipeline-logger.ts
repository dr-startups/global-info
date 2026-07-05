type LogLevel = "info" | "warn" | "error";

function emit(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): void {
  const payload = {
    tag: "orion-v2",
    level,
    scope,
    message,
    ts: new Date().toISOString(),
    ...meta,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.info(line);
}

export function logOrionPipeline(
  scope: string,
  message: string,
  meta?: Record<string, unknown>
): void {
  emit("info", scope, message, meta);
}

export function warnOrionPipeline(
  scope: string,
  message: string,
  meta?: Record<string, unknown>
): void {
  emit("warn", scope, message, meta);
}

export function errorOrionPipeline(
  scope: string,
  message: string,
  meta?: Record<string, unknown>
): void {
  emit("error", scope, message, meta);
}
