export function extractUserSellingPointSeeds(rawBriefText?: string): string[];

export function inferBriefSellingPoints(options?: {
  productName?: string;
  rawBriefText?: string;
  productImageAnalysis?: string;
  outputLanguage?: string;
}): string[];

export function inferProductIdentity(options?: {
  productName?: string;
  rawBriefText?: string;
  productImageAnalysis?: string;
}): {
  id: string;
  label: string;
  confidence: "high" | "medium" | "unknown";
  profile: Record<string, unknown>;
};

export function detectProductIdentityConflict(options?: {
  productName?: string;
  productImageAnalysis?: string;
}): {
  conflicts: boolean;
  nameIdentity: ReturnType<typeof inferProductIdentity>;
  imageIdentity: ReturnType<typeof inferProductIdentity>;
  message: string;
};

export function buildConcreteBriefSections(options?: {
  productName?: string;
  visibleProductName?: string;
  sellingPoints?: string[];
  rawBriefText?: string;
  productImageAnalysis?: string;
  outputLanguage?: string;
}): {
  extractedPoints: string;
  evidence: string;
  risks: string;
  proofMatrix: string;
  mainPlan: string;
  detailPlan: string;
};

export function buildProofMatrixText(options?: {
  productName?: string;
  visibleProductName?: string;
  sellingPoints?: string[];
  rawBriefText?: string;
  productImageAnalysis?: string;
  outputLanguage?: string;
}): string;

export function isLowQualityBriefExpansion(
  content?: string,
  options?: {
    rawBriefText?: string;
    productName?: string;
    productImageAnalysis?: string;
    outputLanguage?: string;
  },
): boolean;

export function briefExpansionQualityIssues(
  content?: string,
  options?: {
    rawBriefText?: string;
    productName?: string;
    productImageAnalysis?: string;
    outputLanguage?: string;
  },
): string[];

export function genericBriefPhrasesForPrompt(): string;

export function inferEvidenceBasedEnglishDisplayName(options?: {
  productName?: string;
  rawBriefText?: string;
  productImageAnalysis?: string;
}): string;

export function visibleDisplayNameEvidenceIssues(options?: {
  visibleName?: string;
  productName?: string;
  productImageAnalysis?: string;
}): string[];
