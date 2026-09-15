export interface PlatformStyleProfile {
  readonly id: string;
  readonly public?: boolean;
  readonly label: string;
  readonly summary: string;
  readonly region: "domestic" | "global";
  readonly aliases: readonly string[];
  readonly promptName: string;
  readonly styleIntent: string;
  readonly defaultAudience: string;
  readonly briefNote: string;
  readonly generatorStyle: string;
  readonly bannedElements: string;
}

export const defaultPlatformStyleId: "domestic-general";
export const platformStyleProfiles: readonly PlatformStyleProfile[];
export function listPlatformStyleProfiles(): Array<Pick<PlatformStyleProfile, "id" | "label" | "summary" | "region">>;
export function platformStyleProfile(value: unknown, fallback?: string): PlatformStyleProfile | undefined;
export function normalizeTargetPlatform(value: unknown, fallback?: string): string;
export function requireTargetPlatform(value: unknown): string;
