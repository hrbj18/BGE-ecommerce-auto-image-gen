export interface ReferenceFileLike {
  name?: string;
  size?: number;
  lastModified?: number;
  type?: string;
}

export interface ReferenceFileItem<T extends ReferenceFileLike = ReferenceFileLike> {
  file: T;
}

export interface ReferenceFileAdditionPlan<T extends ReferenceFileLike = ReferenceFileLike> {
  accepted: T[];
  incomingCount: number;
  invalidCount: number;
  duplicateCount: number;
  overflowCount: number;
  limit: number;
}

type FileCollection<T> = Iterable<T> | ArrayLike<T>;

export function isReferenceImageFile(file: ReferenceFileLike | null | undefined): boolean;
export function referenceFileFingerprint(file: ReferenceFileLike | null | undefined): string;
export function planReferenceFileAddition<T extends ReferenceFileLike>(
  currentItems: FileCollection<T | ReferenceFileItem<T>> | null | undefined,
  incomingItems: FileCollection<T> | null | undefined,
  limit?: number,
): ReferenceFileAdditionPlan<T>;
export function referenceUploadFeedback(plan: ReferenceFileAdditionPlan): string;
