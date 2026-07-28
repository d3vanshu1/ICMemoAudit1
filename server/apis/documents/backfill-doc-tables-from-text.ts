import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// Same slice size as GetDocumentTexts to stay safely under the 10MB wire limit
const SLICE_SIZE = 2_000_000; // 2MB per substring read

// ---------------------------------------------------------------------------
// parsed_text CSV → structured tables
// ---------------------------------------------------------------------------

interface StructuredCell {
  r: number;
  c: number;
  value: number | string | null;
  type: "number" | "string" | "date" | "boolean" | "empty";
}

interface ParsedTable {
  sheetOrPage: string;
  caption: string;
  rowHeaders: string[];
  colHeaders: string[];
  cells: StructuredCell[];
}

/**
 * Parse a CSV value respecting quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Classify a cell value string into a structured cell.
 */
function classifyValue(text: string): { value: number | string | null; type: StructuredCell["type"] } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null, type: "empty" };

  // Strip currency symbols (£, €, $) and thousands separators; handle parenthetical negatives
  const cleaned = trimmed
    .replace(/[£€$,]/g, "")
    .replace(/^\((.+)\)$/, "-$1");
  const isPercent = trimmed.endsWith("%");
  const numStr = isPercent ? cleaned.replace(/%$/, "") : cleaned;

  // Handle magnitude suffixes: k (×1,000), m (×1,000,000), bn (×1,000,000,000)
  const magMatch = numStr.match(/^(-?[\d.]+)\s*(k|m|bn|b)$/i);
  if (magMatch) {
    const base = Number(magMatch[1]);
    if (!isNaN(base)) {
      const suffix = magMatch[2].toLowerCase();
      const multiplier = suffix === "k" ? 1_000
        : suffix === "m" ? 1_000_000
        : /* bn/b */ 1_000_000_000;
      return { value: base * multiplier, type: "number" };
    }
  }

  const num = Number(numStr);

  if (!isNaN(num) && numStr !== "") {
    return {
      value: isPercent ? num / 100 : num,
      type: "number",
    };
  }

  // Date detection (simple ISO-like patterns)
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return { value: trimmed, type: "date" };
  }

  // Log cells that look numeric but failed to parse (currency/magnitude residue)
  if (/[£€$]\s*[\d.]|[\d.]\s*(k|m|bn)\b/i.test(trimmed)) {
    console.log(`[DocTables] Unparseable numeric candidate: "${trimmed}"`);
  }

  return { value: trimmed, type: "string" };
}

/**
 * Convert parsed_text (CSV with sheet separators) into structured tables.
 */
function parsedTextToTables(parsedText: string, fileName: string): ParsedTable[] {
  const tables: ParsedTable[] = [];

  // Split by sheet separators
  const sheetPattern = /^--- Sheet: (.+?) ---$/gm;
  const sections: Array<{ sheetName: string; content: string }> = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = sheetPattern.exec(parsedText)) !== null) {
    if (sections.length > 0) {
      sections[sections.length - 1].content = parsedText.slice(lastIndex, match.index).trim();
    }
    sections.push({ sheetName: match[1], content: "" });
    lastIndex = match.index + match[0].length;
  }

  if (sections.length > 0) {
    sections[sections.length - 1].content = parsedText.slice(lastIndex).trim();
  } else {
    // No sheet separators — treat entire text as one sheet
    sections.push({ sheetName: "Sheet1", content: parsedText.trim() });
  }

  for (const section of sections) {
    if (!section.content) continue;

    const lines = section.content.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;

    // Extract caption from title rows (lines starting with #)
    const titleLines: string[] = [];
    let dataStartIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("# ")) {
        titleLines.push(lines[i].slice(2).trim());
        dataStartIdx = i + 1;
      } else {
        break;
      }
    }

    const caption = titleLines.length > 0 ? titleLines.join(" | ") : section.sheetName;
    const csvLines = lines.slice(dataStartIdx);
    if (csvLines.length === 0) continue;

    // First CSV line = headers
    const colHeaders = parseCsvLine(csvLines[0]);
    const dataLines = csvLines.slice(1);

    // Filter empty rows
    const nonEmptyDataLines = dataLines.filter((line) => {
      const fields = parseCsvLine(line);
      return fields.some((f) => f.trim() !== "");
    });

    const rowHeaders: string[] = [];
    const cells: StructuredCell[] = [];

    for (let ri = 0; ri < nonEmptyDataLines.length; ri++) {
      const fields = parseCsvLine(nonEmptyDataLines[ri]);
      rowHeaders.push(fields[0]?.trim() || "");

      for (let ci = 0; ci < fields.length; ci++) {
        const text = fields[ci]?.trim() || "";
        if (text === "") continue;
        const { value, type } = classifyValue(text);
        cells.push({ r: ri, c: ci, value, type });
      }
    }

    tables.push({
      sheetOrPage: section.sheetName,
      caption,
      rowHeaders,
      colHeaders,
      cells,
    });
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const DocMetaSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  text_length: z.coerce.number(),
});

const TextSliceSchema = z.object({
  text_slice: z.string(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export default api({
  name: "BackfillDocTablesFromText",
  description: "Backfills doc_tables from parsed_text for documents missing structured data",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
  }),

  output: z.object({
    totalTables: z.number(),
    perDocument: z.array(
      z.object({
        documentId: z.string(),
        fileName: z.string(),
        sheetCount: z.number(),
        totalCells: z.number(),
      })
    ),
    warnings: z.array(z.string()),
  }),

  async run(ctx, { dealId }) {
    const warnings: string[] = [];

    // Step 1: Get metadata only (no parsed_text) to avoid the 10MB wire limit
    const docs = await ctx.integrations.db.query(
      `SELECT id, file_name, COALESCE(length(parsed_text), 0) AS text_length
       FROM documents
       WHERE deal_id = $1
         AND parsed_text IS NOT NULL
         AND parsed_text != ''
         AND (file_type LIKE '%spreadsheet%' OR file_type LIKE '%excel%' OR file_type LIKE '%csv%' OR file_name LIKE '%.xlsx' OR file_name LIKE '%.xls' OR file_name LIKE '%.csv')
       ORDER BY uploaded_at
       LIMIT 50`,
      DocMetaSchema,
      [dealId],
      { label: "Fetch Excel/CSV document metadata for backfill" }
    );

    if (docs.length === 0) {
      return { totalTables: 0, perDocument: [], warnings: ["No Excel/CSV documents with parsed_text found for this deal"] };
    }

    let totalTables = 0;
    const perDocument: Array<{ documentId: string; fileName: string; sheetCount: number; totalCells: number }> = [];

    for (const doc of docs) {
      try {
        // Step 2: Load text using chunked reads (same approach as GetDocumentTexts)
        let parsedText: string;

        if (doc.text_length <= SLICE_SIZE) {
          const rows = await ctx.integrations.db.query(
            `SELECT parsed_text AS text_slice FROM documents WHERE id = $1`,
            TextSliceSchema,
            [doc.id],
            { label: `Load text: ${doc.file_name} (${(doc.text_length / 1000).toFixed(0)}KB)` }
          );
          parsedText = rows[0]?.text_slice ?? "";
        } else {
          // Large document — load in slices using substring()
          const slices: string[] = [];
          let offset = 1; // PostgreSQL substring is 1-indexed
          const totalSlices = Math.ceil(doc.text_length / SLICE_SIZE);

          for (let i = 0; i < totalSlices; i++) {
            const rows = await ctx.integrations.db.query(
              `SELECT substring(parsed_text FROM ${offset} FOR ${SLICE_SIZE}) AS text_slice
               FROM documents WHERE id = $1`,
              TextSliceSchema,
              [doc.id],
              { label: `Load slice ${i + 1}/${totalSlices}: ${doc.file_name}` }
            );
            const slice = rows[0]?.text_slice ?? "";
            if (slice.length === 0) break;
            slices.push(slice);
            offset += SLICE_SIZE;
          }

          parsedText = slices.join("");
          warnings.push(`${doc.file_name}: loaded in ${slices.length} slices (${(doc.text_length / 1_000_000).toFixed(1)}MB)`);
        }

        if (!parsedText || parsedText.trim().length === 0) {
          warnings.push(`${doc.file_name}: empty parsed_text after loading`);
          continue;
        }

        // Step 3: Delete existing doc_tables for this document
        await ctx.integrations.db.execute(
          `DELETE FROM doc_tables WHERE document_id = $1`,
          [doc.id],
          { label: `Clear existing doc_tables for ${doc.file_name}` }
        );

        // Step 4: Parse text into structured tables
        const tables = parsedTextToTables(parsedText, doc.file_name);
        let docTotalCells = 0;

        for (const table of tables) {
          docTotalCells += table.cells.length;

          await ctx.integrations.db.execute(
            `INSERT INTO doc_tables (document_id, sheet_or_page, caption, data)
             VALUES ($1, $2, $3, $4)`,
            [
              doc.id,
              table.sheetOrPage,
              table.caption,
              JSON.stringify({
                row_headers: table.rowHeaders,
                col_headers: table.colHeaders,
                cells: table.cells,
              }),
            ],
            { label: `Save doc_table: ${doc.file_name} / ${table.sheetOrPage}` }
          );
        }

        totalTables += tables.length;
        perDocument.push({
          documentId: doc.id,
          fileName: doc.file_name,
          sheetCount: tables.length,
          totalCells: docTotalCells,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`${doc.file_name}: FAILED — ${msg}`);
      }
    }

    return { totalTables, perDocument, warnings };
  },
});
