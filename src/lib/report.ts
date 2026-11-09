import "server-only";
import { PDFDocument, PDFString, StandardFonts, rgb, type PDFImage, type PDFPage, type PDFFont } from "pdf-lib";
import {
  AlignmentType, BorderStyle, ShadingType, Document, ExternalHyperlink, Footer, Header, HeadingLevel, ImageRun, Packer, PageBreak, PageNumber,
  Paragraph, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType,
} from "docx";
import { SCHOOL } from "./brand";
import { LOGO_PNG_BASE64 } from "./brand-logo";

const LOGO_PNG = Buffer.from(LOGO_PNG_BASE64, "base64");
import { loadSheet, thisMonth, type SheetData } from "./data";
import { LEVEL_WORDS, hoursText, monthTitle, shiftMonth, time12, usDate, type AttendanceSummary } from "./sheet";
import type { RowComment } from "./types";

/** One month, or every month of the course up to now. */
export async function loadReport(studentId: string, which: string) {
  const first = await loadSheet(studentId, which === "all" ? thisMonth() : which);
  if (!first) return null;
  const s = first.student;
  if (which !== "all") return { student: s, months: [first] };
  const last = s.endDate.slice(0, 7) < thisMonth() ? s.endDate.slice(0, 7) : thisMonth();
  const months: SheetData[] = [];
  for (let m = s.startDate.slice(0, 7); m <= last; m = shiftMonth(m, 1)) {
    const sheet = await loadSheet(studentId, m);
    if (sheet) months.push(sheet);
  }
  return { student: s, months };
}
export type Report = NonNullable<Awaited<ReturnType<typeof loadReport>>>;

const STATUS_WORD: Record<string, string> = { ABSENT: "Absent", EXCUSED: "Excused", HOLIDAY: "Holiday" };
const pngBytes = (dataUrl: string) => Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
const pngSize = (b: Buffer) => (b.length > 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : { w: 1, h: 1 });
const fit = (w: number, h: number, maxW: number, maxH: number) => { const s = Math.min(maxW / w, maxH / h, 1); return { w: w * s, h: h * s }; };

/** Row values as printed: off days span the time columns with the status word. */
function rowCells(r: SheetData["rows"][number]) {
  const e = r.entry;
  const holidayRow = !!r.holiday || e?.status === "HOLIDAY";
  const off = r.holiday ?? (e && e.status !== "PRESENT" ? STATUS_WORD[e.status] + (e.note ? ` (${e.note})` : "") : null);
  return {
        day: r.weekdayName.toUpperCase(), date: usDate(r.date), off, holiday: holidayRow,
    start: off ? "" : time12(e?.startTime ?? null), end: off ? "" : time12(e?.endTime ?? null), hours: off ? "" : hoursText(e?.minutes),
    // Holidays carry no signatures, even if one was added before this rule.
    studentSig: holidayRow ? null : e?.studentSignature?.id ?? null, staffSig: holidayRow ? null : e?.staffSignature?.id ?? null,
  };
}


// ---------- PDF ----------

/**
 * The PDF's built-in fonts can only write Western European characters; anything else would stop the
 * whole report. Accents are kept where the font has them, other letters lose their accent (Ł -> L),
 * and anything left (emoji, other scripts) becomes "?".
 */
const EXTRA: Record<string, string> = { Ł: "L", ł: "l", Đ: "D", đ: "d", ı: "i", Ħ: "H", ħ: "h", "\u2019": "'", "\u2018": "'", "\u201c": '"', "\u201d": '"', "\u2192": "->", "\u2026": "..." };
export function pdfSafe(text: string, font: PDFFont) {
  const ok = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of String(text ?? "").replace(/[\r\n\t]+/g, " ")) {
    if (ok.has(ch.codePointAt(0)!)) { out += ch; continue; }
    const base = (EXTRA[ch] ?? ch.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    out += [...base].every((c) => ok.has(c.codePointAt(0)!)) && base ? base : "?";
  }
  return out;
}

type PdfCtx = {
  doc: PDFDocument; font: PDFFont; bold: PDFFont; logo: PDFImage;
  image: (id: string | null | undefined, images: Record<string, string>) => Promise<PDFImage | null>;
};

async function pdfContext(title: string): Promise<PdfCtx> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(title, await doc.embedFont(StandardFonts.Helvetica)));
  doc.setAuthor(SCHOOL.name);
  doc.setProducer("BHI Attendance");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedPng(LOGO_PNG);
  const cache = new Map<string, PDFImage>();
  const image = async (id: string | null | undefined, images: Record<string, string>) => {
    if (!id || !images[id]) return null;
    if (!cache.has(id)) {
      try { cache.set(id, await doc.embedPng(pngBytes(images[id]))); } catch { return null; } // a damaged image never stops the report
    }
    return cache.get(id)!;
  };
  return { doc, font, bold, logo, image };
}

export async function buildPdf(report: Report): Promise<Uint8Array> {
  return buildPdfMany([report], `Attendance: ${report.student.name}`);
}

/** Several students' sheets in one PDF (e.g. a whole class for one month). */
export async function buildPdfMany(reports: Report[], title: string): Promise<Uint8Array> {
  const c = await pdfContext(title);
  for (const report of reports) for (const sheet of report.months) await pdfMonth(c, sheet);
  if (!c.doc.getPageCount()) {
    const page = c.doc.addPage([612, 792]);
    pdfLetterhead(c, page, 40, 572);
    pdfFooter(c, page, 40, 572);
    page.drawText("Nothing to show for this selection.", { x: 40, y: 640, size: 12, font: c.font });
  }
  return c.doc.save();
}

/** A clickable area on the page that opens `uri`. */
function pdfLink(doc: PDFDocument, page: PDFPage, x: number, y: number, w: number, h: number, uri: string) {
  const annot = doc.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [x, y, x + w, y + h], Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(uri) },
  });
  page.node.addAnnot(doc.context.register(annot));
}

const PORTRAIT_TOP = 772, LANDSCAPE_TOP = 592, FOOTER_TOP = 50;

/** School letterhead at the top of every page: logo, name, address, phone, email, website. */
function pdfLetterhead(c: PdfCtx, page: PDFPage, L: number, R: number, PAGE_TOP = PORTRAIT_TOP) {
  const navy = rgb(...SCHOOL.colorRgb), grey = rgb(0.25, 0.27, 0.33);
  const size = 58;
  page.drawImage(c.logo, { x: L, y: PAGE_TOP - size, width: size, height: size });
  const tx = L + size + 12;
  page.drawText(SCHOOL.name, { x: tx, y: PAGE_TOP - 20, size: 16, font: c.bold, color: navy });
  // Each piece of contact text is a link, laid out left to right.
  const pieces = (y: number, items: [string, string | null][]) => {
    let x = tx;
    for (const [t, href] of items) {
      const f = href ? c.font : c.bold;
      const w = f.widthOfTextAtSize(t, 8.5);
      page.drawText(t, { x, y, size: 8.5, font: f, color: href ? navy : grey });
      if (href) pdfLink(c.doc, page, x, y - 2, w, 11, href);
      x += w;
    }
  };
  pieces(PAGE_TOP - 35, [["Address: ", null], [SCHOOL.address, SCHOOL.addressHref]]);
  pieces(PAGE_TOP - 48, [["Phone: ", null], [SCHOOL.phone, SCHOOL.phoneHref], ["     Email: ", null], [SCHOOL.email, SCHOOL.emailHref],
    ["     Web: ", null], [SCHOOL.website, SCHOOL.websiteHref]]);
  page.drawLine({ start: { x: L, y: PAGE_TOP - size - 6 }, end: { x: R, y: PAGE_TOP - size - 6 }, thickness: 1.4, color: navy });
  return PAGE_TOP - size - 6;
}

/** Footer on every page: privacy policy link, contact, and when the report was made. */
function pdfFooter(c: PdfCtx, page: PDFPage, L: number, R: number) {
  const navy = rgb(...SCHOOL.colorRgb), grey = rgb(0.4, 0.43, 0.5);
  page.drawLine({ start: { x: L, y: FOOTER_TOP - 8 }, end: { x: R, y: FOOTER_TOP - 8 }, thickness: 0.5, color: grey });
  const y = FOOTER_TOP - 20;
  const label = "Privacy Policy";
  page.drawText(label, { x: L, y, size: 7.5, font: c.bold, color: navy });
  const lw = c.bold.widthOfTextAtSize(label, 7.5);
  pdfLink(c.doc, page, L, y - 2, lw, 10, SCHOOL.privacyHref);
  page.drawLine({ start: { x: L, y: y - 1.2 }, end: { x: L + lw, y: y - 1.2 }, thickness: 0.4, color: navy });
  const contact = `${SCHOOL.name}  ·  ${SCHOOL.phone}  ·  ${SCHOOL.email}`;
  page.drawText(contact, { x: R - c.font.widthOfTextAtSize(contact, 7.5), y, size: 7.5, font: c.font, color: grey });
  page.drawText(`Generated ${new Date().toLocaleString("en-US")}. Times are typed by the student and checked against the school's clock; signatures are handwritten.`, { x: L, y: y - 11, size: 6.5, font: c.font, color: grey });
}

async function pdfMonth(c: PdfCtx, sheet: SheetData) {
  const { doc, font, bold, image } = c;
  const page = doc.addPage([612, 792]); // US Letter
  const ink = rgb(0.11, 0.25, 0.67), black = rgb(0.1, 0.12, 0.18);
  const L = 40, R = 572;
  const text = (p: PDFPage, t: string, x: number, yy: number, size = 8, f = font, color = black) => p.drawText(pdfSafe(t, f), { x, y: yy, size, font: f, color });
  const box = (x: number, yy: number, w: number, h: number) => page.drawRectangle({ x, y: yy, width: w, height: h, borderWidth: 0.8, borderColor: black });

  let y = pdfLetterhead(c, page, L, R) - 18;
  pdfFooter(c, page, L, R);
  text(page, "INDIVIDUAL STUDENT ATTENDANCE SHEET", L, y, 13, bold);
  y -= 6;

  const s = sheet.student;
  const info = [["STUDENT NAME:", s.name, "COURSE NAME:", s.courseName], ["COURSE DURATION:", s.courseDuration, "COURSE CODE:", s.courseCode],
    ["CASE MANAGER:", s.caseManager, "START DATE:", usDate(s.startDate)], ["INSTRUCTOR:", s.instructor, "END DATE:", usDate(s.endDate)]];
  const iw = [100, 166, 90, 176];
  for (const row of info) {
    y -= 15;
    let x = L;
    row.forEach((v, i) => { box(x, y, iw[i], 15); text(page, clip(String(v ?? ""), i % 2 === 0 ? bold : font, 8, iw[i] - 8), x + 4, y + 4.5, 8, i % 2 === 0 ? bold : font); x += iw[i]; });
  }
  y -= 18;
  text(page, `MONTH: ${monthTitle(sheet.month).toUpperCase()}`, L, y, 10, bold);
  y -= 6;

  const cols = [{ t: "", w: 62 }, { t: "DATE", w: 62 }, { t: "START TIME", w: 62 }, { t: "END TIME", w: 62 }, { t: "HOURS", w: 44 }, { t: "STUDENT SIGNATURE", w: 120 }, { t: "STAFF SIGNATURE", w: 120 }];
  // Column headings as on the screen: bold on a light band, centred.
  const headH = 20, headSize = 8.5;
  y -= headH;
  let x = L;
  for (const col of cols) {
    page.drawRectangle({ x, y, width: col.w, height: headH, color: rgb(0.965, 0.973, 0.984), borderWidth: 0.8, borderColor: black });
    text(page, col.t, x + (col.w - bold.widthOfTextAtSize(col.t, headSize)) / 2, y + 7, headSize, bold);
    x += col.w;
  }
  // Rows share what's left between the table header and the approval block, so a long month still fits one page.
  const approvalBlock = 18 + 22 + 15 + 30 + 18 + 26;
  const rowH = Math.min(24, Math.max(11, Math.floor((y - FOOTER_TOP - approvalBlock) / Math.max(1, sheet.rows.length))));
  const fs = rowH < 14 ? 8 : 9;
  for (const r of sheet.rows) {
    y -= rowH;
    const v = rowCells(r);
    x = L;
    const xs = cols.map((col) => { const at = x; x += col.w; return at; });
        // Holiday: one open cell from START TIME to the end of the row (no column lines).
    // Absent / Excused: one cell over the three time columns; signatures stay.
    const spanTo = v.holiday ? 6 : v.off ? 4 : 1;
    cols.forEach((col, i) => { if (i < 2 || i > spanTo) box(xs[i], y, col.w, rowH); });
    if (spanTo > 1) box(xs[2], y, cols.slice(2, spanTo + 1).reduce((t, col) => t + col.w, 0), rowH);
    const mid = y + rowH / 2 - 3;
    const offSize = fs + 1;
    text(page, v.day, xs[0] + 3, mid, 7);
    text(page, v.date, xs[1] + 3, mid, 8);
    if (v.off) {
      // Holiday / Absent / Excused: bold, centred across the three time columns.
            const spanW = cols.slice(2, spanTo + 1).reduce((t, col) => t + col.w, 0);
      let t = pdfSafe(v.off.toUpperCase(), bold);
      while (t.length > 3 && bold.widthOfTextAtSize(t, offSize) > spanW - 8) t = t.slice(0, -2) + "…";
      text(page, t, xs[2] + (spanW - bold.widthOfTextAtSize(t, offSize)) / 2, y + rowH / 2 - offSize * 0.35, offSize, bold, ink);
    } else { text(page, v.start, xs[2] + 4, mid, fs, font, ink); text(page, v.end, xs[3] + 4, mid, fs, font, ink); text(page, v.hours, xs[4] + 4, mid, fs, font, ink); }
    for (const [i, id] of [[5, v.studentSig], [6, v.staffSig]] as const) {
      const img = await image(id, sheet.images);
      if (img) { const d = fit(img.width, img.height, cols[i].w - 8, rowH - 3); page.drawImage(img, { x: xs[i] + (cols[i].w - d.w) / 2, y: y + (rowH - d.h) / 2, width: d.w, height: d.h }); }
    }
  }
  y -= 18;
  box(L, y, 292, 18); text(page, "TOTAL HOURS", L + 200, y + 6, 8, bold);
  box(L + 292, y, 240, 18); text(page, hoursText(sheet.totalMinutes) || "0", L + 298, y + 5.5, 10, bold, ink);

  y -= 22;
  text(page, "Approved by:", L, y, 9, bold);
  const a = sheet.approval;
  y -= 15;
  text(page, clip(`STAFF NAME/POSITION: ${a ? `${a.staffName}${a.position ? `/${a.position}` : ""}`.toUpperCase() : "______________________________"}`, font, 9, R - L), L, y, 9);
  y -= 30;
  text(page, "STAFF SIGNATURE:", L, y + 4, 9);
  const asig = a ? await image(a.signatureId, sheet.images) : null;
  if (asig) { const d = fit(asig.width, asig.height, 150, 30); page.drawImage(asig, { x: L + 92, y: y - 4, width: d.w, height: d.h }); }
  else page.drawLine({ start: { x: L + 92, y: y + 2 }, end: { x: L + 260, y: y + 2 }, thickness: 0.6, color: black });
  if (a) text(page, `Signed ${a.signedAt.toLocaleDateString("en-US")}${sheet.approvalCurrent ? "" : " (rows changed after approval)"}`, L + 270, y + 4, 7);
  y -= 18;
  text(page, "COMMENTS:", L, y, 9);
  const lines = wrap(a?.comments ?? "", font, 9, 440);
  let ly = y;
  let overflow = false;
  for (const [i, l] of lines.entries()) {
    if (ly < FOOTER_TOP + 2) { overflow = true; break; }
    text(page, i === lines.length - 1 || ly - 12 >= FOOTER_TOP + 2 ? l : `${l} …`, L + 60, ly, 9, font, ink);
    ly -= 12;
  }
  // Handwritten approval comments: next to the typed ones if they fit, otherwise on the comments page.
  const aInk = a?.commentsInkId ? await image(a.commentsInkId, sheet.images) : null;
  let inkOnPage = false;
  if (aInk) {
    const room = ly + 8 - FOOTER_TOP;
    if (room >= 22) {
      const d = fit(aInk.width, aInk.height, 300, Math.min(60, room));
      page.drawImage(aInk, { x: L + 60, y: ly + 8 - d.h, width: d.w, height: d.h });
      inkOnPage = true;
    }
  }
  const comments = sheet.rows.flatMap((r) => (r.entry?.comments ?? []).map((cm) => ({ ...cm, date: r.date })));
  if (comments.length || (aInk && !inkOnPage) || overflow) {
    await pdfCommentsPage(c, sheet, comments, aInk && !inkOnPage ? aInk : null, overflow ? a?.comments ?? "" : "");
  } else if (comments.length === 0 && !overflow) {
    // nothing more
  }
}

/** Fits text into a width, adding "…" if it had to be cut. */
function clip(t: string, f: PDFFont, size: number, width: number) {
  let s = pdfSafe(t, f);
  if (f.widthOfTextAtSize(s, size) <= width) return s;
  while (s.length > 1 && f.widthOfTextAtSize(`${s}…`, size) > width) s = s.slice(0, -1);
  return `${s}…`;
}

/** Splits text into lines that fit `width` (long words are broken). */
function wrap(t: string, f: PDFFont, size: number, width: number) {
  const out: string[] = [];
  let line = "";
  for (let w of pdfSafe(t, f).split(/\s+/).filter(Boolean)) {
    while (f.widthOfTextAtSize(w, size) > width) {
      let cut = w.length - 1;
      while (cut > 1 && f.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
      if (line) { out.push(line); line = ""; }
      out.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const next = line ? `${line} ${w}` : w;
    if (f.widthOfTextAtSize(next, size) > width) { out.push(line); line = w; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/**
 * The month's comments (typed and handwritten), and approval comments that didn't fit, on their own
 * page(s) after the sheet.
 */
async function pdfCommentsPage(c: PdfCtx, sheet: SheetData, comments: (RowComment & { date: string })[], approvalInk: PDFImage | null, approvalText: string) {
  const L = 40, R = 572, black = rgb(0.1, 0.12, 0.18), ink = rgb(0.11, 0.25, 0.67), grey = rgb(0.35, 0.38, 0.45);
  let page = c.doc.addPage([612, 792]);
  let y = pdfLetterhead(c, page, L, R) - 24;
  pdfFooter(c, page, L, R);
  const title = () => {
    page.drawText(clip(`COMMENTS: ${sheet.student.name}, ${monthTitle(sheet.month)}`, c.bold, 12, R - L), { x: L, y, size: 12, font: c.bold, color: black });
    y -= 20;
  };
  title();
  const need = (h: number) => {
    if (y - h >= FOOTER_TOP + 6) return;
    page = c.doc.addPage([612, 792]);
    y = pdfLetterhead(c, page, L, R) - 24;
    pdfFooter(c, page, L, R);
    title();
  };
  const block = async (head: string, body: string, img: PDFImage | null) => {
    need(14);
    page.drawText(clip(head, c.bold, 9, R - L), { x: L, y, size: 9, font: c.bold, color: grey });
    y -= 13;
    for (const l of wrap(body, c.font, 10, R - L - 12)) {
      need(13);
      page.drawText(l, { x: L + 12, y, size: 10, font: c.font, color: ink });
      y -= 13;
    }
    if (img) {
      const d = fit(img.width, img.height, 360, 110);
      need(d.h + 4);
      page.drawImage(img, { x: L + 12, y: y - d.h + 8, width: d.w, height: d.h });
      y -= d.h + 2;
    }
    y -= 8;
  };
  if (approvalText || approvalInk) await block(`Approval comments${sheet.approval ? ` (${sheet.approval.staffName})` : ""}`, approvalText, approvalInk);
  const sorted = [...comments].sort((a, b) => a.date.localeCompare(b.date) || new Date(a.at).getTime() - new Date(b.at).getTime());
  for (const cm of sorted) {
    await block(`${usDate(cm.date)}  ${cm.byName}${cm.byRole === "STUDENT" ? " (student)" : ""}, ${new Date(cm.at).toLocaleString("en-US")}`, cm.text, await c.image(cm.inkId, sheet.images));
  }
}

// ---------- Word (DOCX) ----------

const thin = { style: BorderStyle.SINGLE, size: 6, color: "2B3445" };
const borders = { top: thin, bottom: thin, left: thin, right: thin };
const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: none, bottom: none, left: none, right: none };
const cell = (children: (TextRun | ImageRun)[] | string, opts: { width?: number; bold?: boolean; span?: number; ink?: boolean; size?: number; center?: boolean; shade?: boolean } = {}) =>
  new TableCell({
    borders,
    shading: opts.shade ? { type: ShadingType.CLEAR, color: "auto", fill: "F6F8FB" } : undefined,
    columnSpan: opts.span,
    width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    margins: { top: 20, bottom: 20, left: 80, right: 80 },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({
      spacing: { before: 0, after: 0 },
      alignment: opts.center ? AlignmentType.CENTER : undefined,
      children: typeof children === "string"
        ? [new TextRun({ text: children, bold: opts.bold, size: opts.size ?? 16, color: opts.ink ? "1C3FAA" : undefined })]
        : children,
    })],
  });

function sigRun(id: string | null, images: Record<string, string>, maxW: number, maxH: number) {
  if (!id || !images[id]) return [];
  const data = pngBytes(images[id]);
  const { w, h } = pngSize(data);
  const d = fit(w, h, maxW, maxH);
  return [new ImageRun({ data, transformation: { width: Math.round(d.w), height: Math.round(d.h) } })];
}

const link = (text: string, href: string, size = 17) =>
  new ExternalHyperlink({ link: href, children: [new TextRun({ text, size, color: SCHOOL.colorHex, underline: {} })] });
const label = (text: string, size = 17) => new TextRun({ text, size, bold: true, color: "40444F" });

/** School letterhead repeated at the top of every page. */
function docxHeader() {
  const logo = new ImageRun({ data: LOGO_PNG, transformation: { width: 76, height: 76 } });
  return new Header({
    children: [
      new Table({
        width: { size: 10800, type: WidthType.DXA },
        columnWidths: [1500, 9300],
        borders: { ...noBorders, insideHorizontal: none, insideVertical: none },
        rows: [new TableRow({
          children: [
            new TableCell({ borders: noBorders, width: { size: 1500, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER, children: [new Paragraph({ children: [logo] })] }),
            new TableCell({
              borders: noBorders, width: { size: 9300, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
              children: [
                new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: SCHOOL.name, bold: true, size: 32, color: SCHOOL.colorHex })] }),
                new Paragraph({ spacing: { after: 20 }, children: [label("Address: "), link(SCHOOL.address, SCHOOL.addressHref)] }),
                new Paragraph({ children: [
                  label("Phone: "), link(SCHOOL.phone, SCHOOL.phoneHref), label("     Email: "), link(SCHOOL.email, SCHOOL.emailHref),
                  label("     Web: "), link(SCHOOL.website, SCHOOL.websiteHref),
                ] }),
              ],
            }),
          ],
        })],
      }),
      new Paragraph({ spacing: { after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: SCHOOL.colorHex, space: 4 } }, children: [] }),
    ],
  });
}

/** Privacy policy link, contact line and page number at the foot of every page. */
function docxFooter() {
  const grey = (text: string) => new TextRun({ text, size: 14, color: "666E80" });
  return new Footer({
    children: [
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: "A0A6B4", space: 4 } },
        children: [link("Privacy Policy", SCHOOL.privacyHref, 15), grey(`     ${SCHOOL.name}  ·  ${SCHOOL.phone}  ·  ${SCHOOL.email}`)],
      }),
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [grey(`Generated ${new Date().toLocaleString("en-US")}.     `), grey("Page "), new TextRun({ size: 14, color: "666E80", children: [PageNumber.CURRENT] }), grey(" of "), new TextRun({ size: 14, color: "666E80", children: [PageNumber.TOTAL_PAGES] })],
      }),
    ],
  });
}

export async function buildDocx(report: Report): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  report.months.forEach((sheet, idx) => {
    const s = sheet.student;
    if (idx > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "INDIVIDUAL STUDENT ATTENDANCE SHEET", bold: true })] }));
    children.push(new Table({
      width: { size: 9600, type: WidthType.DXA },
      columnWidths: [1900, 2900, 1800, 3000],
      rows: [["STUDENT NAME:", s.name, "COURSE NAME:", s.courseName], ["COURSE DURATION:", s.courseDuration, "COURSE CODE:", s.courseCode],
        ["CASE MANAGER:", s.caseManager, "START DATE:", usDate(s.startDate)], ["INSTRUCTOR:", s.instructor, "END DATE:", usDate(s.endDate)]]
        .map((r) => new TableRow({ children: r.map((v, i) => cell(String(v ?? ""), { width: [1900, 2900, 1800, 3000][i], bold: i % 2 === 0 })) })),
    }));
    children.push(new Paragraph({ spacing: { before: 200, after: 100 }, children: [new TextRun({ text: `MONTH: ${monthTitle(sheet.month).toUpperCase()}`, bold: true })] }));
    const widths = [1200, 1200, 1150, 1150, 800, 2050, 2050];
    const header = new TableRow({ tableHeader: true, children: ["", "DATE", "START TIME", "END TIME", "HOURS", "STUDENT SIGNATURE", "STAFF SIGNATURE"].map((t, i) => cell(t, { width: widths[i], bold: true, size: 17, center: true, shade: true })) });
    const rows = sheet.rows.map((r) => {
      const v = rowCells(r);
      const first = [cell(v.day, { width: widths[0], size: 14 }), cell(v.date, { width: widths[1] })];
            // Holiday: one cell to the end of the row (no column lines, no signature cells).
      if (v.holiday) return new TableRow({ children: [...first, cell((v.off ?? "Holiday").toUpperCase(), { span: 5, ink: true, bold: true, center: true, size: 20, width: widths[2] + widths[3] + widths[4] + widths[5] + widths[6] })] });
      const mid = v.off
        ? [cell(v.off.toUpperCase(), { span: 3, ink: true, bold: true, center: true, size: 20, width: widths[2] + widths[3] + widths[4] })]
        : [cell(v.start, { width: widths[2], ink: true, size: 18 }), cell(v.end, { width: widths[3], ink: true, size: 18 }), cell(v.hours, { width: widths[4], ink: true, size: 18 })];
      return new TableRow({ children: [...first, ...mid, cell(sigRun(v.studentSig, sheet.images, 90, 17), { width: widths[5] }), cell(sigRun(v.staffSig, sheet.images, 90, 17), { width: widths[6] })] });
    });
    const total = new TableRow({ children: [cell("TOTAL HOURS", { span: 4, bold: true, width: widths[0] + widths[1] + widths[2] + widths[3] }), cell(hoursText(sheet.totalMinutes) || "0", { bold: true, ink: true, width: widths[4] }), cell("", { span: 2, width: widths[5] + widths[6] })] });
    children.push(new Table({ width: { size: 9600, type: WidthType.DXA }, columnWidths: widths, rows: [header, ...rows, total] }));
    const a = sheet.approval;
    children.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: "Approved by:", bold: true })] }));
    children.push(new Paragraph({ children: [new TextRun({ text: `STAFF NAME/POSITION: ${a ? `${a.staffName}${a.position ? `/${a.position}` : ""}`.toUpperCase() : "______________________"}` })] }));
    children.push(new Paragraph({ children: [new TextRun({ text: "STAFF SIGNATURE: " }), ...(a ? sigRun(a.signatureId, sheet.images, 160, 40) : [new TextRun("______________________")])] }));
    children.push(new Paragraph({ children: [new TextRun({ text: `COMMENTS: ${a?.comments ?? ""}` })] }));
    if (a?.commentsInkId) children.push(new Paragraph({ children: sigRun(a.commentsInkId, sheet.images, 320, 90) }));
    const comments = sheet.rows.flatMap((r) => (r.entry?.comments ?? []).map((cm) => ({ ...cm, date: r.date })))
      .sort((x, y) => x.date.localeCompare(y.date) || new Date(x.at).getTime() - new Date(y.at).getTime());
    if (comments.length) {
      children.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: "Comments on days", bold: true })] }));
      for (const cm of comments) {
        children.push(new Paragraph({ spacing: { before: 80 }, children: [
          new TextRun({ text: `${usDate(cm.date)}  ${cm.byName}${cm.byRole === "STUDENT" ? " (student)" : ""}: `, bold: true, size: 17 }),
          new TextRun({ text: cm.text, size: 17, color: "1C3FAA" }),
        ] }));
        if (cm.inkId) children.push(new Paragraph({ children: sigRun(cm.inkId, sheet.images, 300, 80) }));
      }
    }
    if (a && !sheet.approvalCurrent) children.push(new Paragraph({ children: [new TextRun({ text: "Note: rows changed after this month was approved.", italics: true })] }));
  });
  const doc = new Document({
    creator: SCHOOL.name,
    styles: { default: { document: { run: { font: "Arial", size: 18 } } } },
    title: `Attendance: ${report.student.name}`,
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 720, bottom: 720, left: 720, right: 720, header: 360, footer: 360 } } },
      headers: { default: docxHeader() },
      footers: { default: docxFooter() },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

// ---------- Monthly report for a class (one row per student) ----------

export type SummaryRow = {
  name: string; course: string; status: string; summary: AttendanceSummary; approved: "current" | "outdated" | null;
};

/** One month, many students: attendance, hours and approval for each, on landscape pages. */
export async function buildMonthSummaryPdf(month: string, course: string, rows: SummaryRow[]): Promise<Uint8Array> {
  const title = `Monthly attendance report: ${monthTitle(month)}${course ? `, ${course}` : ""}`;
  const c = await pdfContext(title);
  const W = 792, L = 40, R = W - 40, black = rgb(0.1, 0.12, 0.18);
  const colors = { good: rgb(0.12, 0.62, 0.33), attention: rgb(0.94, 0.55, 0), poor: rgb(0.85, 0.18, 0.13), none: rgb(0.67, 0.7, 0.75) };
  const cols = [
    { t: "Student", w: 170 }, { t: "Class", w: 150 }, { t: "Status", w: 66 }, { t: "Class days", w: 50 }, { t: "Present", w: 46 },
    { t: "Absent", w: 46 }, { t: "Excused", w: 46 }, { t: "Hours", w: 46 }, { t: "Attendance", w: 92 }, { t: "Approved", w: 0 },
  ];
  cols[cols.length - 1].w = R - L - cols.slice(0, -1).reduce((t, x) => t + x.w, 0);
  const totals = { present: 0, absent: 0, excused: 0, minutes: 0 };
  let page: PDFPage, y = 0;
  const newPage = () => {
    page = c.doc.addPage([W, 612]); // US Letter, landscape
    y = pdfLetterhead(c, page, L, R, LANDSCAPE_TOP) - 22;
    pdfFooter(c, page, L, R);
    page.drawText(pdfSafe(title.toUpperCase(), c.bold), { x: L, y, size: 12, font: c.bold, color: black });
    y -= 22;
    let x = L;
    for (const col of cols) {
      page.drawRectangle({ x, y, width: col.w, height: 18, color: rgb(0.965, 0.973, 0.984), borderWidth: 0.6, borderColor: black });
      page.drawText(col.t, { x: x + 4, y: y + 6, size: 8, font: c.bold, color: black });
      x += col.w;
    }
  };
  newPage();
  for (const r of rows) {
    if (y - 18 < FOOTER_TOP + 30) newPage();
    y -= 17;
    const sm = r.summary;
    totals.present += sm.present; totals.absent += sm.absent + sm.missing; totals.excused += sm.excused; totals.minutes += sm.minutes;
    const vals = [
      r.name, r.course, r.status, String(sm.classDays - sm.holidays), String(sm.present),
      String(sm.absent + sm.missing), String(sm.excused), hoursText(sm.minutes) || "0",
      sm.rate === null ? "-" : `${sm.rate}%`, r.approved === "current" ? "Yes" : r.approved === "outdated" ? "Changed since" : "No",
    ];
    let x = L;
    vals.forEach((v, i) => {
      page.drawRectangle({ x, y, width: cols[i].w, height: 17, borderWidth: 0.4, borderColor: rgb(0.6, 0.63, 0.7) });
      const dx = i === 8 ? 16 : 4;
      if (i === 8) page.drawCircle({ x: x + 8, y: y + 8.5, size: 4, color: colors[sm.level] });
      page.drawText(clip(v, c.font, 8.5, cols[i].w - dx - 4), { x: x + dx, y: y + 5.5, size: 8.5, font: c.font, color: black });
      x += cols[i].w;
    });
  }
  if (!rows.length) { y -= 20; page!.drawText("Nobody in this class had class days this month.", { x: L, y, size: 10, font: c.font }); }
  y -= 26;
  if (y < FOOTER_TOP + 30) { newPage(); y -= 20; }
  page!.drawText(pdfSafe(`${rows.length} students. Present ${totals.present} days, absent ${totals.absent} (including days not recorded), excused ${totals.excused}. ${hoursText(totals.minutes) || "0"} hours in total.`, c.font), { x: L, y, size: 9, font: c.font, color: black });
  y -= 13;
  page!.drawText(pdfSafe(`Colours: green ${LEVEL_WORDS.good.toLowerCase()}, orange ${LEVEL_WORDS.attention.toLowerCase()}, red ${LEVEL_WORDS.poor.toLowerCase()}. Holidays and excused days don't count against a student.`, c.font), { x: L, y, size: 8, font: c.font, color: rgb(0.35, 0.38, 0.45) });
  return c.doc.save();
}
