export interface TaskProgressCountsSource {
  mainImageCount?: unknown;
  detailImageCount?: unknown;
}

export function taskImageCounts(task?: TaskProgressCountsSource | null): { main: number; detail: number };
export function taskProgressLabel(task?: TaskProgressCountsSource | null): string;
