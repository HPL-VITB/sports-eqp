/**
 * Minimal .xlsx reader/writer (first worksheet, text and numbers) on top of JSZip, plus a CSV reader.
 * Enough for the stock import template; tested against files saved by LibreOffice and openpyxl.
 */
import JSZip from "jszip";
import { AppError } from "../errors";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 2000;
const MAX_COLS = 40;
const MAX_XML_CHARS = 30_000_000;

function decodeXml(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
      if (e === "lt") return "<";
      if (e === "gt") return ">";
      if (e === "amp") return "&";
      if (e === "quot") return '"';
      if (e === "apos") return "'";
      const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    });
}

function encodeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
}

/** Concatenates <t> text runs, skipping phonetic (<rPh>) runs. */
function textOf(xml: string): string {
  const cleaned = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of cleaned.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += decodeXml(m[1] ?? "");
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function colLetter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function readPart(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path.replace(/^\//, ""));
  if (!f) return null;
  const s = await f.async("string");
  if (s.length > MAX_XML_CHARS) throw new AppError(413, "FILE_TOO_LARGE", "The spreadsheet is too large.");
  return s;
}

/** Returns the first worksheet as rows of trimmed strings. */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new AppError(400, "FILE_UNREADABLE", "This file is not a valid .xlsx workbook. Save it as Excel Workbook (.xlsx) or CSV and try again.");
  }
  const workbook = await readPart(zip, "xl/workbook.xml");
  const rels = await readPart(zip, "xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new AppError(400, "FILE_UNREADABLE", "This file is not a valid .xlsx workbook.");
  const firstSheet = /<sheet\b([^>]*)\/?>/.exec(workbook);
  const rid = firstSheet ? attr(firstSheet[1]!, "r:id") : undefined;
  let target: string | undefined;
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    if (attr(m[1]!, "Id") === rid) target = attr(m[1]!, "Target");
  }
  if (!target) throw new AppError(400, "FILE_UNREADABLE", "Could not find the first worksheet in this file.");
  const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const sheet = await readPart(zip, sheetPath);
  if (!sheet) throw new AppError(400, "FILE_UNREADABLE", "Could not read the first worksheet.");

  const shared: string[] = [];
  const sst = await readPart(zip, "xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]!));

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rAttr = rm[1] ?? rm[3] ?? "";
    const rowNum = Number(attr(rAttr, "r") ?? rows.length + 1);
    if (rowNum > MAX_ROWS + 1) throw new AppError(400, "TOO_MANY_ROWS", `Import at most ${MAX_ROWS} rows at a time.`);
    const cells: string[] = [];
    let next = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1]!;
      const ref = attr(a, "r");
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      if (idx >= MAX_COLS) continue;
      const t = attr(a, "t");
      const inner = cm[2] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (t === "s") value = shared[Number(v)] ?? "";
      else if (t === "inlineStr") value = textOf(inner);
      else if (t === "b") value = v === "1" ? "TRUE" : "FALSE";
      else if (v !== undefined) value = decodeXml(v);
      cells[idx] = value.trim();
    }
    while (rows.length < rowNum - 1) rows.push([]);
    rows[rowNum - 1] = Array.from(cells, (c) => c ?? "");
  }
  return rows;
}

/** RFC 4180 CSV (comma or semicolon), UTF-8 with or without BOM. */
export function readCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field.trim());
      rows.push(row);
      if (rows.length > MAX_ROWS + 1) throw new AppError(400, "TOO_MANY_ROWS", `Import at most ${MAX_ROWS} rows at a time.`);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

export async function readSpreadsheet(filename: string, bytes: Uint8Array): Promise<string[][]> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new AppError(413, "FILE_TOO_LARGE", "File is larger than 2 MB.");
  if (/\.csv$/i.test(filename)) return readCsv(new TextDecoder("utf-8").decode(bytes));
  if (/\.xls$/i.test(filename)) {
    throw new AppError(400, "FILE_OLD_FORMAT", "Old .xls files are not supported. In Excel choose File › Save As › Excel Workbook (.xlsx).");
  }
  return readXlsx(bytes);
}

export interface SheetSpec {
  name: string;
  /** Strings become text cells; numbers become numeric cells (Excel can sum and sort them). */
  rows: (string | number | null)[][];
  widths?: number[];
  boldFirstRow?: boolean;
}

/** Writes a workbook with text cells (inline strings). Opens in Excel, LibreOffice and Google Sheets. */
export async function writeXlsx(sheets: SheetSpec[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${encodeXml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`,
  );
  sheets.forEach((s, i) => {
    const cols = s.widths?.length
      ? `<cols>${s.widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
      : "";
    const rows = s.rows
      .map((r, ri) => {
        const style = ri === 0 && s.boldFirstRow ? ' s="1"' : "";
        const cells = r
          .map((v, ci) => {
            if (v === "" || v === null || v === undefined) return "";
            if (typeof v === "number" && Number.isFinite(v)) return `<c r="${colLetter(ci)}${ri + 1}"${style}><v>${v}</v></c>`;
            return `<c r="${colLetter(ci)}${ri + 1}" t="inlineStr"${style}><is><t xml:space="preserve">${encodeXml(String(v))}</t></is></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");
    zip.file(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${s.boldFirstRow ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : ""}${cols}<sheetData>${rows}</sheetData></worksheet>`,
    );
  });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
