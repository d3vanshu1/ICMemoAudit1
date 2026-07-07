import type { Deal } from "@/types/deal";
import type { Document, DocumentTag, DocumentSource } from "@/types/document";
import type { ModuleRun, ModuleOutput, ModuleStatus, Finding } from "@/types/module";
import { MODULE_DEFINITIONS } from "./moduleConfig";

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export const DUMMY_DEALS: Deal[] = [
  {
    id: "deal-001",
    name: "Project Atlas",
    description: "Mid-market SaaS platform specializing in supply chain analytics. $120M revenue, 25% YoY growth.",
    sector: "Technology / SaaS",
    status: "active",
    entry_ev: 480_000_000,
    entry_multiple: 12.5,
    equity_check: 210_000_000,
    ic_date: "2026-05-15",
    created_at: "2026-04-10T09:00:00Z",
    updated_at: "2026-04-18T14:30:00Z",
    document_count: 7,
    total_findings: 16,
    critical_findings: 4,
  },
  {
    id: "deal-002",
    name: "Project Beacon",
    description: "Healthcare IT provider focusing on revenue cycle management for mid-size hospital systems.",
    sector: "Healthcare IT",
    status: "active",
    entry_ev: 320_000_000,
    entry_multiple: 8.2,
    equity_check: 145_000_000,
    ic_date: "2026-06-01",
    created_at: "2026-04-12T10:30:00Z",
    updated_at: "2026-04-16T11:15:00Z",
    document_count: 5,
    total_findings: 4,
    critical_findings: 1,
  },
  {
    id: "deal-003",
    name: "Project Cascade",
    description: "Specialty chemicals manufacturer with strong IP portfolio and recurring revenue from toll processing.",
    sector: "Industrials / Chemicals",
    status: "active",
    entry_ev: 750_000_000,
    entry_multiple: 10.0,
    equity_check: 300_000_000,
    ic_date: null,
    created_at: "2026-04-20T15:45:00Z",
    updated_at: "2026-04-20T15:45:00Z",
    document_count: 3,
    total_findings: 0,
    critical_findings: 0,
  },
];

// ---------------------------------------------------------------------------
// Documents (per deal)
// ---------------------------------------------------------------------------

export const DUMMY_DOCUMENTS: Record<string, Document[]> = {
  "deal-001": [
    { id: "doc-101", deal_id: "deal-001", file_name: "Project Atlas CIM - March 2026.pdf", file_type: "application/pdf", document_tag: "cim", document_source: "sellside", uploaded_at: "2026-04-10T09:10:00Z", parsed_text_length: 45200 },
    { id: "doc-102", deal_id: "deal-001", file_name: "IC Memo Draft v3.pdf", file_type: "application/pdf", document_tag: "ic_memo", document_source: "pep", uploaded_at: "2026-04-10T09:12:00Z", parsed_text_length: 28100 },
    { id: "doc-103", deal_id: "deal-001", file_name: "Customer Revenue Cohort Data.xlsx", file_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", document_tag: "customer_data", document_source: "sellside", uploaded_at: "2026-04-11T08:00:00Z", parsed_text_length: 12400 },
    { id: "doc-104", deal_id: "deal-001", file_name: "Bain Technology DD Report.pdf", file_type: "application/pdf", document_tag: "consultant_report", document_source: "pep", uploaded_at: "2026-04-11T08:05:00Z", parsed_text_length: 36800 },
    { id: "doc-105", deal_id: "deal-001", file_name: "Atlas LBO Model v2.xlsx", file_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", document_tag: "financial_model", document_source: "pep", uploaded_at: "2026-04-12T10:30:00Z", parsed_text_length: 8900 },
    { id: "doc-106", deal_id: "deal-001", file_name: "Share Purchase Agreement (Draft).pdf", file_type: "application/pdf", document_tag: "legal", document_source: "sellside", uploaded_at: "2026-04-13T14:00:00Z", parsed_text_length: 52000 },
    { id: "doc-107", deal_id: "deal-001", file_name: "Management Presentation - Feb 2026.pdf", file_type: "application/pdf", document_tag: "other", document_source: "sellside", uploaded_at: "2026-04-13T14:05:00Z", parsed_text_length: 19500 },
  ],
  "deal-002": [
    { id: "doc-201", deal_id: "deal-002", file_name: "Project Beacon CIM.pdf", file_type: "application/pdf", document_tag: "cim", document_source: "sellside", uploaded_at: "2026-04-12T10:35:00Z", parsed_text_length: 38000 },
    { id: "doc-202", deal_id: "deal-002", file_name: "IC Memo - Beacon v1.pdf", file_type: "application/pdf", document_tag: "ic_memo", document_source: "pep", uploaded_at: "2026-04-12T10:40:00Z", parsed_text_length: 22000 },
    { id: "doc-203", deal_id: "deal-002", file_name: "Beacon Revenue by Client.csv", file_type: "text/csv", document_tag: "customer_data", document_source: "sellside", uploaded_at: "2026-04-13T09:00:00Z", parsed_text_length: 6200 },
    { id: "doc-204", deal_id: "deal-002", file_name: "Regulatory Compliance Summary.pdf", file_type: "application/pdf", document_tag: "legal", document_source: "sellside", uploaded_at: "2026-04-14T11:00:00Z", parsed_text_length: 15600 },
    { id: "doc-205", deal_id: "deal-002", file_name: "Beacon LBO Model.xlsx", file_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", document_tag: "financial_model", document_source: "pep", uploaded_at: "2026-04-15T08:30:00Z", parsed_text_length: 7400 },
  ],
  "deal-003": [
    { id: "doc-301", deal_id: "deal-003", file_name: "Project Cascade Teaser.pdf", file_type: "application/pdf", document_tag: "cim", document_source: "sellside", uploaded_at: "2026-04-20T15:50:00Z", parsed_text_length: 12000 },
    { id: "doc-302", deal_id: "deal-003", file_name: "Preliminary Financials.xlsx", file_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", document_tag: "financial_model", document_source: "sellside", uploaded_at: "2026-04-20T15:55:00Z", parsed_text_length: 5100 },
    { id: "doc-303", deal_id: "deal-003", file_name: "Patent Portfolio Overview.pdf", file_type: "application/pdf", document_tag: "other", document_source: "sellside", uploaded_at: "2026-04-21T09:00:00Z", parsed_text_length: 8700 },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(
  severity: Finding["severity"],
  title: string,
  detail: string,
  sourceDocs: string[],
): Finding {
  return {
    severity,
    title,
    detail,
    full_analysis: `## ${title}\n\n${detail}\n\nThis finding was identified by cross-referencing multiple documents in the data room.\n\n### Recommendation\n${severity === "critical" ? "Requires immediate attention and should be raised in the IC meeting." : severity === "warning" ? "Should be addressed before IC submission." : "Worth noting for completeness."}`,
    source_docs: sourceDocs,
  };
}

function makeModuleStatus(
  moduleId: string,
  dealId: string,
  findings: Finding[],
  executiveHeader: string,
  reportMarkdown: string,
): ModuleStatus {
  const runId = `run-${dealId}-${moduleId}`;
  return {
    moduleId,
    latestRun: {
      id: runId,
      deal_id: dealId,
      module_id: moduleId,
      status: "completed",
      triggered_at: "2026-04-17T10:00:00Z",
      completed_at: "2026-04-17T10:12:00Z",
      documents_included: (DUMMY_DOCUMENTS[dealId] ?? []).map((d) => d.id),
    },
    latestOutput: {
      id: `output-${runId}`,
      module_run_id: runId,
      executive_header: executiveHeader,
      findings,
      full_report_markdown: reportMarkdown,
      created_at: "2026-04-17T10:12:00Z",
    },
  };
}

// ---------------------------------------------------------------------------
// Module Statuses (per deal)
// ---------------------------------------------------------------------------

export const DUMMY_MODULE_STATUSES: Record<string, Record<string, ModuleStatus>> = {
  "deal-001": {
    omission_audit: makeModuleStatus(
      "omission_audit", "deal-001",
      [
        makeFinding("critical", "Missing Customer Churn Data", "No churn or retention metrics provided despite SaaS model.", ["Project Atlas CIM - March 2026.pdf"]),
        makeFinding("warning", "No Management References", "CIM lacks management bios, org chart, or key-person risk assessment.", ["Project Atlas CIM - March 2026.pdf", "IC Memo Draft v3.pdf"]),
        makeFinding("info", "Limited Competitive Landscape", "Only two competitors mentioned. No market share data.", ["Project Atlas CIM - March 2026.pdf"]),
      ],
      "3 gaps identified. Critical: customer churn data absent from data room.",
      "# Omission Audit Report\n\n## Summary\n3 notable omissions identified that could impact the investment thesis.\n\n## Critical Gaps\n### 1. Customer Churn Data\nFor a SaaS business at 12.5x, NRR and gross churn are critical metrics — both are missing.\n\n## Recommendations\n- Request NRR and churn data before IC\n- Add management bios and org chart\n- Request competitive positioning analysis",
    ),
    contradiction_check: makeModuleStatus(
      "contradiction_check", "deal-001",
      [
        makeFinding("critical", "Revenue Growth Discrepancy", "CIM states 25% YoY growth but financial model shows 21%. 4-point delta is material at this multiple.", ["Project Atlas CIM - March 2026.pdf", "Atlas LBO Model v2.xlsx"]),
        makeFinding("warning", "Margin Narrative vs. Actuals", "IC memo describes 'expanding margins' but model shows flat EBITDA margin at 22%.", ["IC Memo Draft v3.pdf", "Atlas LBO Model v2.xlsx"]),
      ],
      "2 contradictions found. Critical: 25% vs 21% revenue growth.",
      "# Narrative vs. Data Check\n\n| Claim | Source | Actual | Delta |\n|-------|--------|--------|-------|\n| 25% YoY growth | CIM p.12 | 21% per model | -4pp |\n| Expanding margins | IC Memo p.5 | Flat at 22% | — |",
    ),
    blind_spot_scanner: makeModuleStatus(
      "blind_spot_scanner", "deal-001",
      [
        makeFinding("warning", "Platform Migration Risk", "Cloud migration assumed but no technical DD or timeline provided.", ["IC Memo Draft v3.pdf", "Bain Technology DD Report.pdf"]),
        makeFinding("info", "Regulatory Environment", "No discussion of data privacy regulation changes.", ["Project Atlas CIM - March 2026.pdf"]),
      ],
      "2 blind spots. Key: cloud migration feasibility assumed not validated.",
      "# Blind Spot Scanner\n\n## Platform Migration Risk\nDeal thesis assumes on-premise to cloud migration with no supporting evidence.\n\n## Regulatory\nNo analysis of evolving data privacy landscape.",
    ),
    external_risk_overlay: makeModuleStatus(
      "external_risk_overlay", "deal-001",
      [
        makeFinding("warning", "Emerging Competitor: SupplyVue AI", "SupplyVue AI raised $85M Series C in Q1 2026, directly competing in supply chain analytics.", []),
        makeFinding("info", "EU Supply Chain Directive", "New EU regulation effective 2027 — potential product tailwind.", []),
      ],
      "2 external risks. Well-funded competitor SupplyVue AI not mentioned in deal materials.",
      "# External Risk Overlay\n\n## Competitive Intelligence\n- SupplyVue AI: $85M Series C, direct competitor\n\n## Regulatory\n- EU Supply Chain Due Diligence Directive (2027) — potential tailwind",
    ),
    social_reputation: makeModuleStatus(
      "social_reputation", "deal-001",
      [
        makeFinding("info", "Glassdoor Rating Stable", "3.8/5.0 with 142 reviews. No significant negative trends.", []),
      ],
      "1 finding. Reputation positive with stable Glassdoor ratings.",
      "# Social & Reputation Intelligence\n\n## Glassdoor: 3.8/5.0 (142 reviews)\n- Pros: Good culture, interesting product\n- Cons: Below-market compensation\n\n## LinkedIn: 450 employees, 12% YoY headcount growth",
    ),
    ic_challenge_mode: makeModuleStatus(
      "ic_challenge_mode", "deal-001",
      [
        makeFinding("critical", "Why 12.5x for 21% Growth?", "If growth is 21% (not 25%), how does deal team justify 12.5x vs. 10x sector median?", ["Atlas LBO Model v2.xlsx", "Project Atlas CIM - March 2026.pdf"]),
        makeFinding("warning", "Customer Concentration", "Revenue share of top 5 customers is conspicuously absent.", ["Project Atlas CIM - March 2026.pdf"]),
        makeFinding("warning", "Management Retention", "What retention mechanisms are planned for founding team post-acquisition?", ["IC Memo Draft v3.pdf"]),
      ],
      "3 IC questions. Lead: justification for 12.5x given lower growth.",
      "# IC Challenge Questions\n\n1. **Multiple Justification** — 21% growth vs. 12.5x entry\n2. **Customer Concentration** — Top 5 customer share?\n3. **Management Retention** — Post-close incentives?",
    ),
    model_assumptions_stress: makeModuleStatus(
      "model_assumptions_stress", "deal-001",
      [
        makeFinding("warning", "Revenue Growth Aggressive", "Model assumes 28% CAGR. SaaS comps at this scale average 18-22%.", ["Atlas LBO Model v2.xlsx"]),
        makeFinding("info", "Margin Expansion Plausible", "22% to 30% EBITDA margin expansion is within SaaS benchmarks.", ["Atlas LBO Model v2.xlsx"]),
      ],
      "2 findings. Revenue CAGR of 28% exceeds sector benchmarks.",
      "# Model Stress Test\n\n| Scenario | CAGR | Exit EV | MOIC |\n|----------|------|---------|------|\n| Base | 28% | $1.2B | 2.5x |\n| Sector Median | 20% | $850M | 1.8x |\n| Downside | 15% | $680M | 1.4x |",
    ),
    diligence_completeness: makeModuleStatus(
      "diligence_completeness", "deal-001",
      [
        makeFinding("warning", "Score: 6.5/10", "Below target. Gaps in customer diligence and management assessment.", []),
      ],
      "Score: 6.5/10. Strong in financial/legal, weak in customer/management.",
      "# Diligence Completeness\n\n| Dimension | Score |\n|-----------|-------|\n| Financial | 8/10 |\n| Commercial | 5/10 |\n| Customer | 4/10 |\n| Legal | 7/10 |\n| Management | 3/10 |\n| Technology | 6/10 |\n\n## Overall: **6.5 / 10**",
    ),
    executive_summary: makeModuleStatus(
      "executive_summary", "deal-001",
      [
        makeFinding("critical", "Not IC-Ready", "Revenue growth discrepancy and missing churn data must be resolved before IC.", []),
      ],
      "Not IC-ready. 2 critical items: revenue growth discrepancy, missing churn data.",
      "# Executive Summary — Project Atlas\n\n## Key Risks\n1. Revenue growth discrepancy (25% vs 21%)\n2. Missing churn data\n3. Aggressive model assumptions (28% CAGR)\n\n## IC Readiness: Not Ready\nRecommend requesting churn data and reconciling growth figures before IC.",
    ),
  },
};

// ---------------------------------------------------------------------------
// Run History (per deal, per module)
// ---------------------------------------------------------------------------

export const DUMMY_RUN_HISTORY: Record<string, Record<string, ModuleRun[]>> = {
  "deal-001": {
    omission_audit: [
      {
        id: "run-hist-001",
        deal_id: "deal-001",
        module_id: "omission_audit",
        status: "completed",
        triggered_at: "2026-04-17T10:00:00Z",
        completed_at: "2026-04-17T10:12:00Z",
        documents_included: ["doc-101", "doc-102", "doc-103", "doc-104", "doc-105", "doc-106", "doc-107"],
        findings_count: 3,
        critical_count: 1,
      },
      {
        id: "run-hist-002",
        deal_id: "deal-001",
        module_id: "omission_audit",
        status: "completed",
        triggered_at: "2026-04-15T08:30:00Z",
        completed_at: "2026-04-15T08:45:00Z",
        documents_included: ["doc-101", "doc-102", "doc-103"],
        findings_count: 5,
        critical_count: 2,
      },
    ],
  },
};

export function getModuleStatuses(dealId: string): Record<string, ModuleStatus> {
  return DUMMY_MODULE_STATUSES[dealId] ?? {};
}
