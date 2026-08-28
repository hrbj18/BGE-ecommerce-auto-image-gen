export interface PnpmCommandOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
}

export interface PortableCommand {
  command: string;
  args: string[];
}

export function createPnpmCommand(
  args: string[],
  options?: PnpmCommandOptions,
): PortableCommand;
