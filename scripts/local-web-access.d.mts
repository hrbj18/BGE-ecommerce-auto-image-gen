import type { IncomingMessage } from "node:http";
export function requestClientAddress(req: IncomingMessage): string;
export function normalizeAccessMode(value: unknown): "off" | "token";
export function authorizeWriteRequest(req: IncomingMessage, accessToken: string, accessMode?: string): { ok: boolean; mode?: string; statusCode?: number; code?: string; message?: string };
export function corsOriginForRequest(req: IncomingMessage, allowedOrigins?: string): string;
export function isLoopbackAddress(value: unknown): boolean;
