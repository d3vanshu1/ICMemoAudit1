export interface ModuleDefinition {
  id: string;
  displayName: string;
  description: string;
  iconName: string;
  requiresPriorModules: boolean;
}

export const MODULES: ModuleDefinition[] = [
  {
    id: "omission_audit",
    displayName: "Omission Audit",
    description:
      "Identifies missing information, data gaps, and absent sections across the data room.",
    iconName: "SearchX",
    requiresPriorModules: false,
  },
  {
    id: "contradiction_check",
    displayName: "Narrative vs. Data Check",
    description:
      "Finds inconsistencies between narrative documents (i.e. IC Memo and CIM) and underlying data.",
    iconName: "GitCompareArrows",
    requiresPriorModules: false,
  },
  {
    id: "blind_spot_scanner",
    displayName: "Blind Spot Scanner",
    description:
      "Surfaces implicit assumptions in the thesis that are never explicitly addressed.",
    iconName: "EyeOff",
    requiresPriorModules: false,
  },
  {
    id: "external_risk_overlay",
    displayName: "External Risk Overlay",
    description:
      "Deep web research for regulatory, competitive, and other risks that may not be in IC memo or marketing materials.",
    iconName: "Globe",
    requiresPriorModules: false,
  },
  {
    id: "social_reputation",
    displayName: "Social & Reputation Intelligence",
    description:
      "Researches company reputation across Glassdoor, LinkedIn, X/Twitter, Facebook, Instagram, and review platforms. Cross-references deal team claims against public signals.",
    iconName: "Users",
    requiresPriorModules: false,
  },
  {
    id: "ic_challenge_mode",
    displayName: "IC Questions",
    description:
      "Generates questions that an IC member is likely to ask.",
    iconName: "MessageSquareWarning",
    requiresPriorModules: false,
  },
  {
    id: "model_assumptions_stress",
    displayName: "Model Assumptions Stress Test",
    description:
      "Stress-tests financial model assumptions against data and benchmarks.",
    iconName: "TrendingDown",
    requiresPriorModules: false,
  },
  {
    id: "diligence_completeness",
    displayName: "Diligence Completeness Score",
    description:
      "Scores the data room across 10 standard PE diligence dimensions.",
    iconName: "ClipboardCheck",
    requiresPriorModules: false,
  },
  {
    id: "executive_summary",
    displayName: "Executive Summary",
    description:
      "Synthesizes all module outputs into an IC-ready executive brief.",
    iconName: "FileText",
    requiresPriorModules: true,
  },
];

export const MODULE_DEFINITIONS = MODULES;

// ---------------------------------------------------------------------------
// Numeric-eligible modules — mirrors server/apis/modules/constants.ts.
// IMPORTANT: Keep in sync with that file. These are the modules that receive
// numeric verification reports as authoritative input during merge & format.
// ---------------------------------------------------------------------------
export const NUMERIC_MODULE_IDS = [
  "model_assumptions_stress",
  "contradiction_check",
] as const;

export type NumericModuleId = (typeof NUMERIC_MODULE_IDS)[number];

/** Pre-built Set for O(1) membership checks */
export const NUMERIC_MODULES = new Set<string>(NUMERIC_MODULE_IDS);

export const MODULE_MAP = Object.fromEntries(
  MODULES.map((m) => [m.id, m]),
);
