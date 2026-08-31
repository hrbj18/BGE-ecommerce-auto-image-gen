import type { ChildProcess } from "node:child_process";
export function createOnceAsyncFinalizer<T extends unknown[]>(handler: (...args: T) => Promise<void> | void): (...args: T) => Promise<void>;
export function terminateProcessTree(child: ChildProcess, options?: { platform?: NodeJS.Platform; graceMs?: number; spawnSync?: (...args: unknown[]) => unknown }): Promise<void>;
export function windowsTaskkillArgs(pid: number): string[];
