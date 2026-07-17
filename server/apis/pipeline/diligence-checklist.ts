/**
 * DILIGENCE_CHECKLIST — Fixed PE due diligence categories with search queries.
 *
 * Each category defines:
 *  - id: stable key used in coverage maps and findings
 *  - label: human-readable category name
 *  - queries: 2+ distinct full-text search queries to find coverage
 *             (uses websearch_to_tsquery syntax: OR for alternatives, quotes for phrases)
 *  - description: what constitutes adequate coverage for this category
 *
 * The checklist scan runs EVERY query against EVERY document chunk in the deal,
 * producing a structured evidence map that the merge layer uses as ground truth.
 */

export interface ChecklistCategory {
  id: string;
  label: string;
  queries: string[];
  description: string;
}

export const DILIGENCE_CHECKLIST: ChecklistCategory[] = [
  {
    id: "qoe_status",
    label: "Quality of Earnings (QoE)",
    queries: [
      "quality of earnings OR QoE OR earnings adjustments",
      "EBITDA adjustments OR normalized EBITDA OR pro forma earnings",
      "one-time charges OR non-recurring items OR add-backs",
    ],
    description: "QoE report status, EBITDA normalization methodology, identified adjustments, and bridge from reported to adjusted earnings.",
  },
  {
    id: "customer_concentration",
    label: "Customer Concentration",
    queries: [
      "customer concentration OR top customers OR largest clients",
      "revenue concentration OR top 10 customers OR key accounts",
      "single customer dependency OR client diversification",
    ],
    description: "Revenue breakdown by top customers, concentration percentages, contract terms with major clients, churn risk per account.",
  },
  {
    id: "retention_methodology",
    label: "Retention / Churn Methodology",
    queries: [
      "retention rate OR churn rate OR customer attrition",
      "logo retention OR net revenue retention OR NRR OR GRR",
      "renewal rate OR contract renewal OR customer lifetime",
    ],
    description: "How retention is measured (logo vs. dollar vs. net), historical trends, cohort-level data, and methodology definition.",
  },
  {
    id: "capex",
    label: "Capital Expenditures",
    queries: [
      "capital expenditure OR capex OR capital spending",
      "maintenance capex OR growth capex OR PP&E investments",
      "fixed asset additions OR depreciation OR useful life",
    ],
    description: "Capex breakdown (maintenance vs. growth), historical spend, forward projections, and relationship to revenue growth.",
  },
  {
    id: "key_man_retention",
    label: "Key Man / Retention Terms",
    queries: [
      "key man OR key person OR management retention",
      "employment agreement OR non-compete OR golden handcuffs",
      "founder transition OR CEO succession OR management continuity",
    ],
    description: "Key personnel identification, retention packages, non-compete terms, succession planning, and transition risk.",
  },
  {
    id: "mip_mechanics",
    label: "Management Incentive Plan (MIP)",
    queries: [
      "management incentive OR MIP OR equity pool OR management rollover",
      "sweet equity OR ratchet OR carried interest OR co-invest",
      "performance hurdles OR vesting schedule OR MOIC threshold",
    ],
    description: "MIP structure, pool size, vesting, performance hurdles, alignment with fund return targets.",
  },
  {
    id: "exit_comps",
    label: "Exit Comparables / Valuation",
    queries: [
      "exit multiple OR exit valuation OR comparable transactions",
      "EV/EBITDA multiple OR trading comps OR precedent transactions",
      "IRR sensitivity OR MOIC OR money on invested capital",
    ],
    description: "Exit assumptions, comparable transaction multiples, sensitivity to multiple expansion/compression, IRR/MOIC targets.",
  },
  {
    id: "regulatory_status",
    label: "Regulatory / Compliance Status",
    queries: [
      "regulatory OR compliance OR licensing OR permits",
      "government approval OR regulatory risk OR legal compliance",
      "industry regulation OR data privacy OR GDPR OR SOC",
    ],
    description: "Regulatory environment, required licenses/permits, compliance status, pending regulatory actions or changes.",
  },
  {
    id: "competitive_positioning",
    label: "Competitive Positioning",
    queries: [
      "competitive landscape OR market position OR competitors",
      "market share OR competitive advantage OR moat OR differentiation",
      "barriers to entry OR switching costs OR competitive threat",
    ],
    description: "Market position, key competitors, differentiation strategy, barriers to entry, and vulnerability to competitive response.",
  },
  {
    id: "revenue_recognition",
    label: "Revenue Recognition",
    queries: [
      "revenue recognition OR ASC 606 OR IFRS 15",
      "contract revenue OR deferred revenue OR billing model",
      "recurring revenue OR ARR OR MRR OR subscription revenue",
    ],
    description: "Revenue recognition policies, contract structures, deferred revenue trends, ARR/MRR definitions and methodology.",
  },
  {
    id: "legal_contractual",
    label: "Legal / Contractual",
    queries: [
      "litigation OR legal proceedings OR pending claims",
      "material contracts OR change of control OR assignment",
      "indemnification OR warranty claims OR contingent liabilities",
    ],
    description: "Pending/threatened litigation, material contract terms (especially change-of-control), indemnification obligations.",
  },
  {
    id: "working_capital",
    label: "Working Capital",
    queries: [
      "working capital OR net working capital OR NWC",
      "accounts receivable OR DSO OR collection days",
      "accounts payable OR inventory turnover OR cash conversion",
    ],
    description: "Working capital normalization, NWC mechanism, seasonal patterns, DSO/DPO trends, and peg amount.",
  },
  {
    id: "tax",
    label: "Tax",
    queries: [
      "tax structure OR tax exposure OR tax risk",
      "deferred tax OR NOL OR net operating loss OR tax shield",
      "transfer pricing OR tax jurisdiction OR effective tax rate",
    ],
    description: "Tax structure, material exposures, NOL utilization, jurisdictional risks, and post-acquisition tax planning.",
  },
  {
    id: "ip_tech_dependencies",
    label: "IP / Technology Dependencies",
    queries: [
      "intellectual property OR patents OR proprietary technology",
      "technology stack OR platform dependencies OR tech debt",
      "third-party software OR vendor lock-in OR open source",
    ],
    description: "IP ownership and protection, technology platform risks, third-party dependencies, and tech debt assessment.",
  },
  {
    id: "related_party",
    label: "Related-Party Transactions",
    queries: [
      "related party OR affiliated transactions OR insider dealings",
      "management fees OR shareholder loans OR intercompany",
      "arm's length OR related entity OR connected persons",
    ],
    description: "Related-party transactions, arms-length confirmation, management fee elimination, shareholder loan treatment.",
  },
  {
    id: "insurance",
    label: "Insurance Coverage",
    queries: [
      "insurance coverage OR insurance policy OR insured risks",
      "D&O insurance OR key man insurance OR business interruption",
      "underinsured OR coverage gap OR policy limits",
    ],
    description: "Insurance program adequacy, D&O coverage, key-man policies, identified coverage gaps, and premium costs.",
  },
];

/**
 * Returns all category IDs for quick iteration.
 */
export function getChecklistCategoryIds(): string[] {
  return DILIGENCE_CHECKLIST.map(c => c.id);
}
