import { api, z, readableFileSchema } from "@superblocksteam/sdk-api";

// We use a minimal inline ZIP parser since the SDK runtime sandbox
// doesn't have access to node_modules. The .xlsx format uses ZIP with
// DEFLATE compression. We use a dynamic import for zlib to avoid Vite
// externalization errors (this code only executes server-side).

let _inflateRawSync: ((buf: Buffer | Uint8Array) => Buffer) | null = null;
function getInflateRawSync(): (buf: Buffer | Uint8Array) => Buffer {
  if (!_inflateRawSync) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zlib = require("zlib");
    _inflateRawSync = zlib.inflateRawSync;
  }
  return _inflateRawSync!;
}

/**
 * Diagnostic: Tests OOXML formula extraction against a real .xlsx file.
 * Upload the file and specify cells to inspect.
 */

// --- Minimal ZIP parser (handles STORE and DEFLATE methods) ---

function parseZip(buffer: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  let offset = 0;

  // Also parse from the central directory as a fallback for sizes
  const centralDirSizes = new Map<string, { compressedSize: number; uncompressedSize: number }>();
  // Find End of Central Directory record (last 22+ bytes)
  let eocdOffset = buffer.length - 22;
  while (eocdOffset >= 0 && buffer.readUInt32LE(eocdOffset) !== 0x06054b50) eocdOffset--;
  if (eocdOffset >= 0) {
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    let pos = cdOffset;
    while (pos < eocdOffset && buffer.readUInt32LE(pos) === 0x02014b50) {
      const cSize = buffer.readUInt32LE(pos + 20);
      const ucSize = buffer.readUInt32LE(pos + 24);
      const fnLen = buffer.readUInt16LE(pos + 28);
      const exLen = buffer.readUInt16LE(pos + 30);
      const cmLen = buffer.readUInt16LE(pos + 32);
      const fn = buffer.toString("utf8", pos + 46, pos + 46 + fnLen);
      centralDirSizes.set(fn, { compressedSize: cSize, uncompressedSize: ucSize });
      pos += 46 + fnLen + exLen + cmLen;
    }
  }

  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // Not a local file header

    const generalPurposeFlags = buffer.readUInt16LE(offset + 6);
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    let compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraFieldLength = buffer.readUInt16LE(offset + 28);

    const fileName = buffer.toString("utf8", offset + 30, offset + 30 + fileNameLength);
    const dataStart = offset + 30 + fileNameLength + extraFieldLength;

    // If data descriptor flag is set and local header says 0, look up from central dir
    if (compressedSize === 0 && (generalPurposeFlags & 0x08)) {
      const cdInfo = centralDirSizes.get(fileName);
      if (cdInfo) compressedSize = cdInfo.compressedSize;
    }

    const rawData = buffer.subarray(dataStart, dataStart + compressedSize);

    if (!fileName.endsWith("/")) { // Skip directories
      if (compressionMethod === 0) {
        files[fileName] = Buffer.from(rawData);
      } else if (compressionMethod === 8) {
        try {
          files[fileName] = getInflateRawSync()(rawData);
        } catch {
          // Skip files that fail to decompress
        }
      }
    }

    offset = dataStart + compressedSize;
    // Skip data descriptor if present (12 or 16 bytes)
    if (generalPurposeFlags & 0x08) {
      if (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x08074b50) {
        offset += 16; // sig + crc32 + compressedSize + uncompressedSize
      } else {
        offset += 12; // crc32 + compressedSize + uncompressedSize (no sig)
      }
    }
  }

  return files;
}

// --- OOXML formula extraction logic ---

interface SharedFormulaAnchor {
  anchorRow: number;
  anchorCol: number;
  formula: string;
}

function colLetterToIdx(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function idxToColLetter(idx: number): string {
  let result = "";
  let n = idx + 1;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function decodeAddress(addr: string): { row: number; col: number } {
  const match = addr.match(/^([A-Z]{1,3})(\d+)$/i);
  if (!match) return { row: 0, col: 0 };
  return { col: colLetterToIdx(match[1].toUpperCase()), row: parseInt(match[2], 10) - 1 };
}

function decodeXmlEntities(str: string): string {
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function shiftFormula(formula: string, rowOffset: number, colOffset: number): string | null {
  if (rowOffset === 0 && colOffset === 0) return formula;

  const cellRefRegex = /(\$?)([A-Z]{1,3})(\$?)(\d+)/gi;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  cellRefRegex.lastIndex = 0;

  while ((match = cellRefRegex.exec(formula)) !== null) {
    const colAbsolute = match[1] === "$";
    const colLetters = match[2];
    const rowAbsolute = match[3] === "$";
    const rowNum = parseInt(match[4], 10);

    result += formula.slice(lastIndex, match.index);

    let newCol = colLetterToIdx(colLetters.toUpperCase());
    let newRow = rowNum - 1;

    if (!colAbsolute) newCol += colOffset;
    if (!rowAbsolute) newRow += rowOffset;

    if (newRow < 0 || newCol < 0 || newCol > 16383 || newRow > 1048575) return null;

    result += `${colAbsolute ? "$" : ""}${idxToColLetter(newCol)}${rowAbsolute ? "$" : ""}${newRow + 1}`;
    lastIndex = match.index + match[0].length;
  }

  result += formula.slice(lastIndex);
  return result;
}

function parseWorksheetFormulas(xml: string): Map<string, string> {
  const formulaMap = new Map<string, string>();
  const sharedAnchors = new Map<string, SharedFormulaAnchor>();
  const sharedMembers: Array<{ addr: string; si: string }> = [];

  const cellWithFormulaRegex = /<c\s[^>]*?r="([A-Z]{1,3}\d+)"[^>]*?>([\s\S]*?)<\/c>/g;
  let cellMatch: RegExpExecArray | null;

  while ((cellMatch = cellWithFormulaRegex.exec(xml)) !== null) {
    const addr = cellMatch[1];
    const cellContent = cellMatch[2];

    const fMatch = cellContent.match(/<f(\s[^>]*)?\/?>([\s\S]*?)(?:<\/f>)?/);
    if (!fMatch) continue;

    const fAttrs = fMatch[1] || "";
    const rawFormulaText = fMatch[0];

    // Extract formula text: content between <f...> and </f>
    let formulaText = "";
    const fullFMatch = cellContent.match(/<f[^>]*>([\s\S]*?)<\/f>/);
    if (fullFMatch) {
      formulaText = fullFMatch[1].trim();
    }

    const isSelfClosing = rawFormulaText.trimEnd().endsWith("/>");

    const typeMatch = fAttrs.match(/\bt="([^"]*)"/);
    const siMatch = fAttrs.match(/\bsi="([^"]*)"/);

    const fType = typeMatch?.[1] || "";
    const si = siMatch?.[1] || "";

    if (fType === "shared") {
      if (formulaText) {
        const { row, col } = decodeAddress(addr);
        sharedAnchors.set(si, { anchorRow: row, anchorCol: col, formula: formulaText });
        formulaMap.set(addr, formulaText);
      } else {
        sharedMembers.push({ addr, si });
      }
    } else if (fType === "array") {
      if (formulaText) formulaMap.set(addr, formulaText);
    } else {
      if (formulaText) formulaMap.set(addr, formulaText);
    }
  }

  for (const { addr, si } of sharedMembers) {
    const anchor = sharedAnchors.get(si);
    if (!anchor) continue;
    const { row: memberRow, col: memberCol } = decodeAddress(addr);
    const shifted = shiftFormula(anchor.formula, memberRow - anchor.anchorRow, memberCol - anchor.anchorCol);
    if (shifted !== null) formulaMap.set(addr, shifted);
  }

  return formulaMap;
}

function resolveSheetFiles(files: Record<string, Buffer>): Map<string, string> {
  const result = new Map<string, string>();
  const workbookXml = files["xl/workbook.xml"];
  if (!workbookXml) return result;

  const wbStr = workbookXml.toString("utf8");
  const sheetToRId = new Map<string, string>();
  const sheetRegex = /<sheet\s[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"[^>]*?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = sheetRegex.exec(wbStr)) !== null) {
    sheetToRId.set(decodeXmlEntities(m[1]), m[2]);
  }

  const relsXml = files["xl/_rels/workbook.xml.rels"];
  if (!relsXml) return result;
  const relsStr = relsXml.toString("utf8");
  const rIdToTarget = new Map<string, string>();
  const relRegex = /<Relationship\s[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"[^>]*?\/?>/gi;
  while ((m = relRegex.exec(relsStr)) !== null) {
    rIdToTarget.set(m[1], m[2]);
  }

  for (const [sheetName, rId] of sheetToRId) {
    const target = rIdToTarget.get(rId);
    if (target) {
      result.set(sheetName, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
  }
  return result;
}

// --- API ---

export default api({
  name: "DiagFormulaExtraction",
  description: "Tests OOXML formula extraction on an uploaded .xlsx file",

  input: z.object({
    xlsxFile: z.object({
      files: z.array(readableFileSchema).min(1),
    }),
    sheetName: z.string().describe("Sheet to inspect"),
    cellAddresses: z.array(z.string()).describe("Cell addresses to check, e.g. ['H207','I207','J207','K207']"),
  }),

  output: z.object({
    sheetFound: z.boolean(),
    totalFormulasExtracted: z.number(),
    requestedCells: z.array(z.object({
      address: z.string(),
      formula: z.string().nullable(),
    })),
    /** Sample of first 20 formulas found in the sheet for context */
    sampleFormulas: z.array(z.object({
      address: z.string(),
      formula: z.string(),
    })),
    /** Stats about shared formula resolution */
    stats: z.object({
      plainFormulas: z.number(),
      sharedAnchors: z.number(),
      sharedMembers: z.number(),
      unresolvedMembers: z.number(),
    }),
  }),

  async run(_ctx, input) {
    const file = input.xlsxFile.files[0];
    const content = await file.readContentsAsync("raw");
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content as string, "utf8");

    // Unzip using our inline ZIP parser
    let files: Record<string, Buffer>;
    try {
      files = parseZip(buffer);
    } catch (e) {
      throw new Error(`Failed to unzip file: ${e}`);
    }

    // Resolve sheet files
    const sheetFileMap = resolveSheetFiles(files);

    // Find the requested sheet
    const xmlPath = sheetFileMap.get(input.sheetName);
    if (!xmlPath) {
      return {
        sheetFound: false,
        totalFormulasExtracted: 0,
        requestedCells: input.cellAddresses.map(addr => ({ address: addr, formula: null })),
        sampleFormulas: [],
        stats: { plainFormulas: 0, sharedAnchors: 0, sharedMembers: 0, unresolvedMembers: 0 },
      };
    }

    const xmlBytes = files[xmlPath];
    if (!xmlBytes) {
      return {
        sheetFound: false,
        totalFormulasExtracted: 0,
        requestedCells: input.cellAddresses.map(addr => ({ address: addr, formula: null })),
        sampleFormulas: [],
        stats: { plainFormulas: 0, sharedAnchors: 0, sharedMembers: 0, unresolvedMembers: 0 },
      };
    }

    const xmlStr = xmlBytes.toString("utf8");

    // Parse with stats tracking
    const formulaMap = new Map<string, string>();
    const sharedAnchors = new Map<string, SharedFormulaAnchor>();
    const sharedMembers: Array<{ addr: string; si: string }> = [];
    let plainCount = 0;

    const cellWithFormulaRegex = /<c\s[^>]*?r="([A-Z]{1,3}\d+)"[^>]*?>([\s\S]*?)<\/c>/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellWithFormulaRegex.exec(xmlStr)) !== null) {
      const addr = cellMatch[1];
      const cellContent = cellMatch[2];

      const fullFMatch = cellContent.match(/<f[^>]*>([\s\S]*?)<\/f>/);
      const selfClosingFMatch = cellContent.match(/<f([^>]*?)\/>/);

      let formulaText = "";
      let fAttrs = "";

      if (fullFMatch) {
        formulaText = fullFMatch[1].trim();
        const attrMatch = fullFMatch[0].match(/<f([^>]*?)>/);
        fAttrs = attrMatch?.[1] || "";
      } else if (selfClosingFMatch) {
        fAttrs = selfClosingFMatch[1] || "";
        formulaText = "";
      } else {
        continue;
      }

      const typeMatch = fAttrs.match(/\bt="([^"]*)"/);
      const siMatch = fAttrs.match(/\bsi="([^"]*)"/);
      const fType = typeMatch?.[1] || "";
      const si = siMatch?.[1] || "";

      if (fType === "shared") {
        if (formulaText) {
          const { row, col } = decodeAddress(addr);
          sharedAnchors.set(si, { anchorRow: row, anchorCol: col, formula: formulaText });
          formulaMap.set(addr, formulaText);
        } else {
          sharedMembers.push({ addr, si });
        }
      } else {
        if (formulaText) {
          formulaMap.set(addr, formulaText);
          plainCount++;
        }
      }
    }

    let unresolvedCount = 0;
    for (const { addr, si } of sharedMembers) {
      const anchor = sharedAnchors.get(si);
      if (!anchor) { unresolvedCount++; continue; }
      const { row: memberRow, col: memberCol } = decodeAddress(addr);
      const shifted = shiftFormula(anchor.formula, memberRow - anchor.anchorRow, memberCol - anchor.anchorCol);
      if (shifted !== null) {
        formulaMap.set(addr, shifted);
      } else {
        unresolvedCount++;
      }
    }

    // Build output
    const requestedCells = input.cellAddresses.map(addr => ({
      address: addr,
      formula: formulaMap.get(addr) ?? null,
    }));

    const sampleFormulas: Array<{ address: string; formula: string }> = [];
    let count = 0;
    for (const [addr, formula] of formulaMap) {
      if (count >= 20) break;
      sampleFormulas.push({ address: addr, formula });
      count++;
    }

    return {
      sheetFound: true,
      totalFormulasExtracted: formulaMap.size,
      requestedCells,
      sampleFormulas,
      stats: {
        plainFormulas: plainCount,
        sharedAnchors: sharedAnchors.size,
        sharedMembers: sharedMembers.length,
        unresolvedMembers: unresolvedCount,
      },
    };
  },
});
