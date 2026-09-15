export interface OutputLanguageProfile {
  readonly id: string;
  readonly label: string;
  readonly displayLabel: string;
  readonly promptName: string;
  readonly aliases: readonly string[];
  readonly baseLanguage: "English" | "Simplified Chinese";
  readonly rtl: boolean;
}

export const outputLanguageProfiles: readonly OutputLanguageProfile[];
export function outputLanguageProfile(value: unknown, fallback?: string): OutputLanguageProfile | undefined;
export function normalizeOutputLanguage(value: unknown, fallback?: string): string;
export function outputLanguageDisplayLabel(value: unknown, fallback?: string): string;
export function requireOutputLanguage(value: unknown): string;
export function outputLanguagePromptName(value: unknown, fallback?: string): string;
export function usesEnglishLanguageBaseline(value: unknown): boolean;
export function isRightToLeftOutputLanguage(value: unknown): boolean;
export function outputLanguageInstruction(value: unknown): string;
