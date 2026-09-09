export type PublicImageResolutionId = "720p" | "1k" | "2k";
export type ImageResolutionId = PublicImageResolutionId | "4k";
export type ProviderImageResolution = "1k" | "2k" | "4k";

export interface ImageResolutionProfile {
  id: ImageResolutionId;
  label: string;
  summary: string;
  description: string;
  providerResolution: ProviderImageResolution;
  mainWidth: number;
  mainHeight: number;
  detailWidth: number;
  detailHeight: number;
  nativeProviderSize: boolean;
}

export const defaultImageResolutionId: "2k";
export function listImageResolutionProfiles(): Array<ImageResolutionProfile & { id: PublicImageResolutionId }>;
export function findImageResolutionProfile(value: unknown): (ImageResolutionProfile & { id: PublicImageResolutionId }) | null;
export function resolveImageResolutionProfile(value: unknown): ImageResolutionProfile & { id: PublicImageResolutionId };
export function imageResolutionProfileForTask(
  task: { imageResolutionId?: string } | null | undefined,
  fallbackResolution?: ProviderImageResolution | PublicImageResolutionId,
): ImageResolutionProfile;
export function imageDimensionsForRole(
  profile: ImageResolutionProfile,
  role: "main" | "detail",
  aspectRatio?: "1:1" | "3:4" | "9:16",
): { width: number; height: number };
