export interface GenerationProfile {
  id: "standard-5-8" | "compact-1-2" | "compact-2-3" | "compact-3-4" | "legacy-custom";
  label: string;
  summary: string;
  suiteRatio: string;
  mainImageCount: number;
  detailImageCount: number;
}

export const defaultGenerationProfileId: "standard-5-8";
export function listGenerationProfiles(): Array<Omit<GenerationProfile, "id"> & { id: "standard-5-8" | "compact-1-2" | "compact-2-3" | "compact-3-4" }>;
export function findGenerationProfile(value: unknown): (Omit<GenerationProfile, "id"> & { id: "standard-5-8" | "compact-1-2" | "compact-2-3" | "compact-3-4" }) | null;
export function resolveGenerationProfile(value: unknown): Omit<GenerationProfile, "id"> & { id: "standard-5-8" | "compact-1-2" | "compact-2-3" | "compact-3-4" };
export function detailImageCountForTask(task: { generateDetail?: boolean; detailImageCount?: number; generationProfileId?: string } | null | undefined): number;
export function generationProfileForTask(task: { mainImageCount?: number; generateDetail?: boolean; detailImageCount?: number; generationProfileId?: string; suiteRatio?: string } | null | undefined): GenerationProfile;
export function overviewFilename(kind: "main" | "detail", count: number): string;
