export class AtomicJsonStore {
  constructor(filePath: string, options?: { backupIntervalMs?: number; fs?: unknown });
  load(): Promise<{ value: unknown; source: "primary" | "backup" | "missing"; recovered: boolean; primaryError?: unknown; backupError?: unknown }>;
  save(value: unknown): Promise<void>;
  flush(): Promise<void>;
  cleanupTemporaryFiles(): Promise<void>;
}
