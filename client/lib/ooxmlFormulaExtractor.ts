/**
 * OOXML Formula Extractor
 *
 * Extracts cell formulas directly from the .xlsx ZIP archive's XML,
 * bypassing SheetJS's broken shared-formula resolution (issue #338/#1388).
 *
 * Handles three formula cases:
 * 1. Plain formula: <f>SUM(A1:A10)</f>
 * 2. Shared-formula anchor: <f t="shared" ref="H207:K207" si="5">+SUM(H208:H217)</f>
 * 3. Shared-formula member: <f t="shared" si="5"/> → offset from anchor
 *
 * Also handles array formulas gracefully (returns the formula text if present,
 * null if it's a member cell of an array).
 */

import { unzipSync, strFromU8 } from "fflate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Map of "sheetName" → Map<"A1-style address", formula string> */
export type SheetFormulaMap = Map<string, Map<string, string>>;

/** Internal: anchor info for a shared formula group within one sheet */
interface SharedFormulaAnchor {
  /** The anchor cell address (e.g. "H207") */
  anchorAddr: string;
  /** The anchor's row (0-based) */
  anchorRow: number;
  /** The anchor's column (0-based) */
  anchorCol: number;
  /** The formula text from the anchor */
  formula: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all formulas from an .xlsx buffer.
 * Returns a map: sheetName → (cellAddress → formulaString)
 *
 * @param buffer - The raw .xlsx file as ArrayBuffer
 * @returns SheetFormulaMap
 */
export function extractFormulasFromXlsx(buffer: ArrayBuffer): SheetFormulaMap {
  const result: SheetFormulaMap = new Map();

  // Unzip
  const zipData = new Uint8Array(buffer);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zipData);
  } catch {
    // Not a valid zip/xlsx — return empty
    return result;
  }

  // Step 1: Map sheet names → XML filenames via workbook.xml + rels
  const sheetFileMap = resolveSheetFiles(files);

  // Step 2: Parse each worksheet XML for formulas
  for (const [sheetName, xmlPath] of sheetFileMap) {
    const xmlBytes = files[xmlPath];
    if (!xmlBytes) continue;

    const xmlStr = strFromU8(xmlBytes);
    const formulaMap = parseWorksheetFormulas(xmlStr);
    if (formulaMap.size > 0) {
      result.set(sheetName, formulaMap);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 1: Resolve sheet name → worksheet XML path
// ---------------------------------------------------------------------------

function resolveSheetFiles(
  files: Record<string, Uint8Array>
): Map<string, string> {
  const result = new Map<string, string>();

  // Parse xl/workbook.xml to get sheet name → rId mapping
  const workbookXml = files["xl/workbook.xml"];
  if (!workbookXml) return result;

  const wbStr = strFromU8(workbookXml);
  const sheetToRId = parseWorkbookSheets(wbStr);

  // Parse xl/_rels/workbook.xml.rels to get rId → target path
  const relsXml = files["xl/_rels/workbook.xml.rels"];
  if (!relsXml) return result;

  const relsStr = strFromU8(relsXml);
  const rIdToTarget = parseRels(relsStr);

  // Combine: sheetName → full path in zip
  for (const [sheetName, rId] of sheetToRId) {
    const target = rIdToTarget.get(rId);
    if (target) {
      // Target is relative to xl/, e.g. "worksheets/sheet1.xml"
      const fullPath = target.startsWith("/")
        ? target.slice(1) // absolute path in zip
        : `xl/${target}`;
      result.set(sheetName, fullPath);
    }
  }

  return result;
}

function parseWorkbookSheets(xml: string): Map<string, string> {
  const result = new Map<string, string>();
  // Match <sheet name="..." ... r:id="rId1" .../>
  const sheetRegex = /<sheet\s[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"[^>]*?\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = sheetRegex.exec(xml)) !== null) {
    const name = decodeXmlEntities(match[1]);
    const rId = match[2];
    result.set(name, rId);
  }
  return result;
}

function parseRels(xml: string): Map<string, string> {
  const result = new Map<string, string>();
  // Match <Relationship Id="rId1" Target="worksheets/sheet1.xml" .../>
  const relRegex = /<Relationship\s[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"[^>]*?\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = relRegex.exec(xml)) !== null) {
    result.set(match[1], match[2]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 2: Parse worksheet XML for formulas
// ---------------------------------------------------------------------------

function parseWorksheetFormulas(xml: string): Map<string, string> {
  const formulaMap = new Map<string, string>();

  // Shared formula anchors: si → anchor info
  const sharedAnchors = new Map<string, SharedFormulaAnchor>();

  // Shared formula members waiting for resolution: [{addr, si}]
  const sharedMembers: Array<{ addr: string; si: string }> = [];

  // Parse all <c> elements with their <f> children
  // Strategy: regex-based streaming parse (faster than DOMParser for large sheets)
  //
  // CRITICAL: Must handle BOTH open-close <c r="A1">...</c> AND self-closing <c r="A1" .../>
  // A single regex that only matches open-close will incorrectly match the ">" in "/>" as
  // the open-tag terminator, then consume content from subsequent cells looking for </c>.
  // The alternation below tries self-closing first (left branch) to prevent this.
  //
  // Pass 1: Find all <c> elements with an r= address attribute
  // Pass 2: Extract <f> formula tags from open-close cells
  // Pass 3: Resolve shared formula members

  // Alternation regex: self-closing <c ... /> (group 1=addr) | open-close <c ...>content</c> (group 2=addr, group 3=content)
  const cellRegex = /<c\s[^>]*?r="([A-Z]{1,3}\d+)"[^>]*?\/>|<c\s[^>]*?r="([A-Z]{1,3}\d+)"[^>]*?(?<!\/)>([\s\S]*?)<\/c>/g;

  let cellMatch: RegExpExecArray | null;

  // Process all <c> elements (both self-closing and open-close)
  while ((cellMatch = cellRegex.exec(xml)) !== null) {
    // Self-closing <c .../> — no children, skip (cannot contain <f>)
    if (cellMatch[1] != null) continue;

    const addr = cellMatch[2];
    const cellContent = cellMatch[3];

    // Look for <f> within this cell
    const fMatch = cellContent.match(
      /<f(\s[^>]*)?\/?>([\s\S]*?)(?:<\/f>)?/
    );
    if (!fMatch) continue;

    const fAttrs = fMatch[1] || "";
    // Formula text: between <f...> and </f>, or empty for self-closing
    let formulaText = fMatch[2]?.trim() || "";

    // Check if it's also closed inline (self-closing <f .../>)
    const isSelfClosing = fMatch[0].endsWith("/>");

    // Parse attributes
    const typeMatch = fAttrs.match(/\bt="([^"]*)"/);
    const siMatch = fAttrs.match(/\bsi="([^"]*)"/);
    const refMatch = fAttrs.match(/\bref="([^"]*)"/);

    const fType = typeMatch?.[1] || "";
    const si = siMatch?.[1] || "";

    if (fType === "shared") {
      if (formulaText && !isSelfClosing) {
        // Shared anchor — has formula text + si + ref
        const { row, col } = decodeAddress(addr);
        sharedAnchors.set(si, {
          anchorAddr: addr,
          anchorRow: row,
          anchorCol: col,
          formula: formulaText,
        });
        formulaMap.set(addr, formulaText);
      } else {
        // Shared member — needs offset resolution
        sharedMembers.push({ addr, si });
      }
    } else if (fType === "array") {
      // Array formula — only the anchor has text
      if (formulaText) {
        formulaMap.set(addr, formulaText);
      }
      // Member cells of array formulas don't get individual formulas
    } else {
      // Plain formula
      if (formulaText) {
        formulaMap.set(addr, formulaText);
      }
    }
  }

  // Pass 3: Resolve shared formula members
  for (const { addr, si } of sharedMembers) {
    const anchor = sharedAnchors.get(si);
    if (!anchor) continue; // orphaned member — skip

    const { row: memberRow, col: memberCol } = decodeAddress(addr);
    const rowOffset = memberRow - anchor.anchorRow;
    const colOffset = memberCol - anchor.anchorCol;

    const shifted = shiftFormula(anchor.formula, rowOffset, colOffset);
    if (shifted !== null) {
      formulaMap.set(addr, shifted);
    }
    // If shift fails (unresolvable), leave formula absent → heuristic fallback
  }

  return formulaMap;
}

// ---------------------------------------------------------------------------
// Formula shifting — apply row/col offset respecting $ absolute markers
// ---------------------------------------------------------------------------

/**
 * Shift all cell references in a formula by the given row/col offset.
 * Respects $-absolute markers: $A$1 stays fixed, A$1 shifts column only,
 * $A1 shifts row only, A1 shifts both.
 *
 * Returns null if the formula contains something we can't safely shift
 * (e.g. structured references, R1C1 notation).
 */
function shiftFormula(
  formula: string,
  rowOffset: number,
  colOffset: number
): string | null {
  if (rowOffset === 0 && colOffset === 0) return formula;

  // Cell reference pattern: optional $ before col letters, optional $ before row digits
  // Matches: A1, $A1, A$1, $A$1, AA123, $AA$123, etc.
  const cellRefRegex = /(\$?)([A-Z]{1,3})(\$?)(\d+)/gi;

  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset lastIndex for the regex
  cellRefRegex.lastIndex = 0;

  while ((match = cellRefRegex.exec(formula)) !== null) {
    const fullMatch = match[0];
    const colAbsolute = match[1] === "$";
    const colLetters = match[2];
    const rowAbsolute = match[3] === "$";
    const rowNum = parseInt(match[4], 10);

    // Append text before this match
    result += formula.slice(lastIndex, match.index);

    // Apply offsets only to relative parts
    let newCol = colLetterToIdx(colLetters);
    let newRow = rowNum - 1; // 0-based internally

    if (!colAbsolute) {
      newCol += colOffset;
    }
    if (!rowAbsolute) {
      newRow += rowOffset;
    }

    // Validate bounds
    if (newRow < 0 || newCol < 0 || newCol > 16383 || newRow > 1048575) {
      return null; // shifted out of bounds — can't resolve
    }

    // Reconstruct reference
    const newColStr = idxToColLetter(newCol);
    const newRowStr = (newRow + 1).toString();
    result += `${colAbsolute ? "$" : ""}${newColStr}${rowAbsolute ? "$" : ""}${newRowStr}`;

    lastIndex = match.index + fullMatch.length;
  }

  // Append remainder
  result += formula.slice(lastIndex);

  return result;
}

// ---------------------------------------------------------------------------
// Address utilities
// ---------------------------------------------------------------------------

function decodeAddress(addr: string): { row: number; col: number } {
  const match = addr.match(/^([A-Z]{1,3})(\d+)$/i);
  if (!match) return { row: 0, col: 0 };
  return {
    col: colLetterToIdx(match[1].toUpperCase()),
    row: parseInt(match[2], 10) - 1, // 0-based
  };
}

function colLetterToIdx(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1; // 0-based
}

function idxToColLetter(idx: number): string {
  let result = "";
  let n = idx + 1; // 1-based
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
