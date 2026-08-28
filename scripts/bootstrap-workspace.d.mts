export interface BootstrapResult {
  root: string;
  created: string[];
  preserved: string[];
}

export function bootstrapWorkspace(root?: string): Promise<BootstrapResult>;
