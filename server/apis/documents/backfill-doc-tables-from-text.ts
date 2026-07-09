import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

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

  // Try to parse as number (handle currency, commas, parentheses for negatives, percentages)
  const cleaned = trimmed.replace(/[$,]/g, "").replace(/^\((.+)\)$/, "-$1");
  const isPercent = trimmed.endsWith("%");
  const numStr = isPercent ? cleaned.replace(/%$/, "") : cleaned;
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
  }),

  async run(ctx, { dealId }) {
    // Get all Excel/CSV documents for this deal that have parsed_text
    const DocSchema = z.object({
      id: z.string(),
      file_name: z.string(),
      parsed_text: z.string(),
    });

    const docs = await ctx.integrations.db.query(
      `SELECT id, file_name, parsed_text
       FROM documents
       WHERE deal_id = $1
         AND parsed_text IS NOT NULL
         AND parsed_text != ''
         AND (file_type LIKE '%spreadsheet%' OR file_type LIKE '%excel%' OR file_type LIKE '%csv%' OR file_name LIKE '%.xlsx' OR file_name LIKE '%.xls' OR file_name LIKE '%.csv')
       ORDER BY uploaded_at
       LIMIT 50`,
      DocSchema,
      [dealId],
      { label: "Fetch Excel/CSV documents for backfill" }
    );

    if (docs.length === 0) {
      ctx.log.info("No Excel/CSV documents with parsed_text found for this deal");
      return { totalTables: 0, perDocument: [] };
    }

    let totalTables = 0;
    const perDocument: Array<{ documentId: string; fileName: string; sheetCount: number; totalCells: number }> = [];

    for (const doc of docs) {
      // Delete existing doc_tables for this document
      await ctx.integrations.db.execute(
        `DELETE FROM doc_tables WHERE document_id = $1`,
        [doc.id],
        { label: `Clear existing doc_tables for ${doc.file_name}` }
      );

      const tables = parsedTextToTables(doc.parsed_text, doc.file_name);
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

      ctx.log.info(`Backfilled ${tables.length} tables (${docTotalCells} cells) from ${doc.file_name}`);
    }

    return { totalTables, perDocument };
  },
});
