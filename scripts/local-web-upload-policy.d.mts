import type { IncomingMessage } from "node:http";
export interface UploadLimits { maxRequestBytes: number; maxFileBytes: number; maxTemplateBytes: number; maxBriefChars: number; maxFiles: number; maxPixels: number; maxDimension: number }
export class LocalWebHttpError extends Error { statusCode: number; code: string; detail: Record<string, unknown> }
export function readUploadLimits(env?: NodeJS.ProcessEnv): UploadLimits;
export function parseMultipartForm(req: IncomingMessage, limits: UploadLimits, requestUrl?: string): Promise<FormData>;
export function validateBriefInputs(input: { template?: File | null; templateText?: string; briefText?: string; briefFocus?: string }, limits: UploadLimits): void;
export function validateReferenceImages(files: File[], limits: UploadLimits): Promise<Array<{ file: File; data: Buffer; format: string; width: number; height: number; extension: string }>>;
export function findLocalWebHttpError(error: unknown): LocalWebHttpError | null;
