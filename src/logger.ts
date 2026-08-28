export type LogLevel = "info" | "warn" | "error";

export class Logger {
  info(message: string, details?: unknown): void {
    this.write("info", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.write("warn", message, details);
  }

  error(message: string, details?: unknown): void {
    this.write("error", message, details);
  }

  private write(level: LogLevel, message: string, details?: unknown): void {
    const payload = [`[${new Date().toISOString()}]`, level.toUpperCase(), message];
    if (details === undefined) {
      console.log(payload.join(" "));
      return;
    }
    console.log(`${payload.join(" ")} ${formatDetails(details)}`);
  }
}

function formatDetails(details: unknown): string {
  if (details instanceof Error) {
    return `${details.name}: ${details.message}`;
  }
  if (typeof details === "string") {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}
