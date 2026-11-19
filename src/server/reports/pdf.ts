/**
 * Minimal PDF writer for tabular reports: A4 landscape, built-in Helvetica (no font files), repeated header row,
 * page numbers. Cell text that does not fit is shortened with "…" (the Excel export always has the full text).
 * Characters outside the Windows-1252 set (e.g. Devanagari) are printed as "?"; names are expected in Latin script.
 */
export interface PdfColumn {
  label: string;
  width: number; // relative weight
  align?: "left" | "right";
}

export interface PdfTable {
  title: string;
  subtitle?: string;
  columns: PdfColumn[];
  rows: (string | number | null)[][];
  footer?: string;
}

const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 30;
const FONT_SIZE = 7.5;
const HEADER_SIZE = 7.5;
const ROW_H = 11;

// Helvetica advance widths (1/1000 em) for ASCII 32..126, from the standard AFM.
const W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
  584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// Unicode -> Windows-1252 byte for the 0x80-0x9F range.
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89,
  0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Converts text to Windows-1252 code points (unsupported characters become "?"). */
function toCodes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.replace(/[\r\n\t]+/g, " ")) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c < 127) out.push(c);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (CP1252[c] !== undefined) out.push(CP1252[c]!);
    else if (c === 0x20b9) out.push(82, 115); // ₹ -> Rs
    else out.push(63);
  }
  return out;
}

function width(codes: number[], size: number, bold = false): number {
  let w = 0;
  for (const c of codes) w += c >= 32 && c <= 126 ? W[c - 32]! : 556;
  return (w * size * (bold ? 1.06 : 1)) / 1000;
}

function fit(text: string, maxW: number, size: number, bold = false): number[] {
  let codes = toCodes(text);
  if (width(codes, size, bold) <= maxW) return codes;
  const ell = 0x85;
  while (codes.length > 0 && width([...codes, ell], size, bold) > maxW) codes = codes.slice(0, -1);
  return [...codes, ell];
}

function pdfString(codes: number[]): string {
  let s = "(";
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += "\\" + String.fromCharCode(c);
    else s += String.fromCharCode(c);
  }
  return s + ")";
}

function text(x: number, y: number, codes: number[], font: "F1" | "F2", size: number): string {
  return `BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(codes)} Tj ET\n`;
}

export function writePdf(t: PdfTable): Uint8Array {
  const usable = PAGE_W - 2 * MARGIN;
  const totalWeight = t.columns.reduce((a, c) => a + c.width, 0);
  const widths = t.columns.map((c) => (c.width / totalWeight) * usable);
  const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const top = PAGE_H - MARGIN;
  const firstTableY = top - 40;
  const rowsPerPage = Math.max(1, Math.floor((firstTableY - ROW_H - MARGIN - 14) / ROW_H));
  const pageCount = Math.max(1, Math.ceil(t.rows.length / rowsPerPage));

  const pages: string[] = [];
  for (let p = 0; p < pageCount; p++) {
    let c = "0.2 w 0.6 G\n";
    c += text(MARGIN, top - 12, fit(t.title, usable, 13, true), "F2", 13);
    if (t.subtitle) c += text(MARGIN, top - 26, fit(t.subtitle, usable, 8), "F1", 8);
    let y = firstTableY;
    // header
    c += `0.93 g ${MARGIN} ${(y - 3).toFixed(2)} ${usable} ${ROW_H} re f 0 g\n`;
    t.columns.forEach((col, i) => {
      const codes = fit(col.label, widths[i]! - 4, HEADER_SIZE, true);
      const x = col.align === "right" ? xs[i]! + widths[i]! - 2 - width(codes, HEADER_SIZE, true) : xs[i]! + 2;
      c += text(x, y, codes, "F2", HEADER_SIZE);
    });
    y -= ROW_H;
    for (const row of t.rows.slice(p * rowsPerPage, (p + 1) * rowsPerPage)) {
      row.forEach((cell, i) => {
        const col = t.columns[i];
        if (!col || cell === null || cell === undefined || cell === "") return;
        const codes = fit(String(cell), widths[i]! - 4, FONT_SIZE);
        const x = col.align === "right" ? xs[i]! + widths[i]! - 2 - width(codes, FONT_SIZE) : xs[i]! + 2;
        c += text(x, y, codes, "F1", FONT_SIZE);
      });
      c += `${MARGIN} ${(y - 3).toFixed(2)} m ${PAGE_W - MARGIN} ${(y - 3).toFixed(2)} l S\n`;
      y -= ROW_H;
    }
    if (t.rows.length === 0) c += text(MARGIN + 2, y, toCodes("No records match these filters."), "F1", FONT_SIZE);
    const foot = `${t.footer ?? ""}${t.footer ? "   ·   " : ""}Page ${p + 1} of ${pageCount}`;
    c += text(MARGIN, MARGIN - 12, toCodes(foot.replace("·", "-")), "F1", 7);
    pages.push(c);
  }

  // Assemble objects: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, then (page, content) pairs.
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((content, i) => {
    const pid = pageIds[i]!;
    objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pid + 1} 0 R >>`;
    objs[pid + 1] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`;
  });

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
