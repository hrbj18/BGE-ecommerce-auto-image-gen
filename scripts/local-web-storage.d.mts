export interface DiskStatus { ok: boolean; minimumBytes: number; minimumGiB: number; availableBytes: number; availableGiB: number; checks: Array<Record<string, unknown>> }
export class InsufficientStorageError extends Error { statusCode: number; code: string; status: DiskStatus }
export function minimumFreeBytes(env?: NodeJS.ProcessEnv): number;
export function inspectDiskSpace(paths: string[], options?: { minimumBytes?: number; statfs?: (path: string) => Promise<Record<string, bigint | number>> }): Promise<DiskStatus>;
export function requireDiskSpace(paths: string[], options?: { minimumBytes?: number; statfs?: (path: string) => Promise<Record<string, bigint | number>> }): Promise<DiskStatus>;
