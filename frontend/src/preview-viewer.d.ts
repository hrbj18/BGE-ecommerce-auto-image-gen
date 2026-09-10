export interface PreviewAsset {
  id?: string;
  group?: string;
  typeLabel?: string;
  label?: string;
  filename?: string;
  url?: string;
  layout?: string;
}

export const previewZoomMin: number;
export const previewZoomMax: number;
export const previewZoomStep: number;

export function clampPreviewZoom(value: unknown): number;
export function isCompositePreviewAsset(asset?: PreviewAsset | null): boolean;
export function relatedPreviewAssets(asset?: PreviewAsset | null, assets?: PreviewAsset[]): PreviewAsset[];
export function defaultPreviewMode(asset?: PreviewAsset | null): "overview" | "composite" | "single";
export function defaultPreviewFit(asset?: PreviewAsset | null, mode?: string): "width" | "window";
export function previewModeLabel(asset?: PreviewAsset | null): "完整长图" | "拼接图";
