export type ImageAspectRatio = "1:1" | "3:4" | "9:16";
export type PublicImageAspectRatioProfileId = "ecommerce-standard" | "portrait-main";

export interface ImageAspectRatioProfile {
  id: PublicImageAspectRatioProfileId;
  label: string;
  summary: string;
  description: string;
  mainAspectRatio: ImageAspectRatio;
  detailAspectRatio: ImageAspectRatio;
}

export const defaultImageAspectRatioProfileId: "ecommerce-standard";
export function listImageAspectRatioProfiles(): ImageAspectRatioProfile[];
export function findImageAspectRatioProfile(value: unknown): ImageAspectRatioProfile | null;
export function resolveImageAspectRatioProfile(value: unknown): ImageAspectRatioProfile;
export function imageAspectRatioProfileForTask(
  task: { imageAspectRatioProfileId?: string; suiteRatio?: string } | null | undefined,
): ImageAspectRatioProfile;
export function aspectRatioForRole(
  profile: ImageAspectRatioProfile,
  role: "main" | "detail",
): ImageAspectRatio;
