export interface PortalDraftUser {
  username?: unknown;
}

export interface ReferenceDraftImage {
  id?: unknown;
  file: File | Blob;
  previewUrl?: string;
  originalName?: unknown;
  role?: unknown;
  useForExpansion?: boolean;
  type?: unknown;
  lastModified?: unknown;
}

export interface StoredReferenceDraftImage {
  id: string;
  file: File | Blob;
  originalName: string;
  role: string;
  useForExpansion: boolean;
  type: string;
  lastModified: number;
}

export interface RestoredReferenceDraftImage {
  id: string;
  file: File;
  previewUrl: string;
  originalName: string;
  role: string;
  useForExpansion: boolean;
}

export function referenceDraftScope(portalUser?: PortalDraftUser | null): string;
export function referenceDraftSnapshot(images?: Iterable<ReferenceDraftImage> | ArrayLike<ReferenceDraftImage> | null): StoredReferenceDraftImage[];
export function restoreReferenceDraft(
  items?: Iterable<Partial<StoredReferenceDraftImage>> | ArrayLike<Partial<StoredReferenceDraftImage>> | null,
  createObjectUrl?: (file: File) => string,
): RestoredReferenceDraftImage[];
export function loadReferenceDraft(scope: string): Promise<StoredReferenceDraftImage[]>;
export function saveReferenceDraft(
  scope: string,
  images?: Iterable<ReferenceDraftImage> | ArrayLike<ReferenceDraftImage> | null,
): Promise<void>;
