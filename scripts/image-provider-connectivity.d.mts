export interface ImageProviderConnectivityResult {
  available: boolean;
  provider: "openai" | "aiecho";
  host: string;
  status?: number;
  reason?: string;
}

export interface ImageProviderConnectivityOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function checkImageProviderConnectivity(options?: ImageProviderConnectivityOptions): Promise<ImageProviderConnectivityResult>;
export function requireImageProviderConnectivity(options?: ImageProviderConnectivityOptions): Promise<ImageProviderConnectivityResult>;
