export type DocumentSource = "sellside" | "pep" | null;

export interface Document {
  id: string;
  deal_id: string;
  file_name: string;
  file_type: string;
  document_tag: DocumentTag;
  document_source: DocumentSource;
  uploaded_at: string;
  parsed_text_length?: number;
}

export type DocumentTag =
  | "cim"
  | "ic_memo"
  | "customer_data"
  | "consultant_report"
  | "financial_model"
  | "legal"
  | "other";

export const DOCUMENT_TAG_LABELS: Record<DocumentTag, string> = {
  cim: "CIM",
  ic_memo: "IC Memo",
  customer_data: "Customer Data",
  consultant_report: "Consultant Report",
  financial_model: "Financial Model",
  legal: "Legal",
  other: "Other",
};

export const DOCUMENT_SOURCE_LABELS: Record<
  NonNullable<DocumentSource>,
  string
> = {
  sellside: "Sellside",
  pep: "PEP",
};
