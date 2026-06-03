import { PDFDocument, rgb, StandardFonts } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';
import { ORG_CONFIG } from '../config/org.js';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

const VENUE_LABELS = {
  telephone: 'Telephone', email: 'Email', zoom: 'Zoom',
  inPerson: 'In Person', letter: 'Letter', other: 'Other'
};

function _venueStr(venues, other) {
  const labels = venues
    .filter(v => v !== 'other')
    .map(v => VENUE_LABELS[v] || v);
  if (venues.includes('other') && other) labels.push(other);
  return labels.join(', ');
}

function _placeCountry(place, country) {
  return [place, country].filter(Boolean).join(' – ');
}

export class PDFGenerator {
  constructor() {
    this.pdfDoc = null;
    this.currentPage = null;
    this.currentY = 0;
    this.font = null;
    this.fontBold = null;
    this.margins = ORG_CONFIG.pdf.margins;
    this.colors = ORG_CONFIG.pdf.colors;
    this.fonts = ORG_CONFIG.pdf.fonts;
    this.contentWidth = PAGE_WIDTH - this.margins.left - this.margins.right;
  }

  async init() {
    this.pdfDoc = await PDFDocument.create();
    this.pdfDoc.setTitle('Recruiting Report');
    this.pdfDoc.setAuthor(ORG_CONFIG.pdf.author);
    this.pdfDoc.setCreationDate(new Date());

    this.font = await this.pdfDoc.embedFont(StandardFonts.Helvetica);
    this.fontBold = await this.pdfDoc.embedFont(StandardFonts.HelveticaBold);

    this.addNewPage();
  }

  addNewPage() {
    this.currentPage = this.pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.currentY = PAGE_HEIGHT - this.margins.top;
  }

  addPageIfNeeded(neededHeight) {
    if (this.currentY - neededHeight < this.margins.bottom) {
      this.addNewPage();
      return true;
    }
    return false;
  }

  addSpace(space) { this.currentY -= space; }

  _sanitize(text) {
    return (text || '').replace(/[\r\n]+/g, ' ').trim();
  }

  drawLine() {
    this.addPageIfNeeded(15);
    this.currentY -= 5;
    this.currentPage.drawLine({
      start: { x: this.margins.left, y: this.currentY },
      end: { x: PAGE_WIDTH - this.margins.right, y: this.currentY },
      thickness: 0.5,
      color: rgb(this.colors.lightGray.r, this.colors.lightGray.g, this.colors.lightGray.b)
    });
    this.currentY -= 10;
  }

  async drawOrgHeader() {
    let logoBytes = null;
    try {
      const resp = await fetch(ORG_CONFIG.logoPath);
      if (resp.ok) logoBytes = new Uint8Array(await (await resp.blob()).arrayBuffer());
    } catch {}

    if (logoBytes) {
      try {
        let img;
        try { img = await this.pdfDoc.embedPng(logoBytes); }
        catch { img = await this.pdfDoc.embedJpg(logoBytes); }

        const maxH = 60, maxW = 150;
        const aspect = img.width / img.height;
        let w = maxW, h = w / aspect;
        if (h > maxH) { h = maxH; w = h * aspect; }

        this.currentPage.drawImage(img, {
          x: this.margins.left, y: this.currentY - h, width: w, height: h
        });
      } catch {}
    }

    const rightX = PAGE_WIDTH - this.margins.right;
    let textY = this.currentY - 12;

    const nameW = this.fontBold.widthOfTextAtSize(ORG_CONFIG.name, 11);
    this.currentPage.drawText(ORG_CONFIG.name, {
      x: rightX - nameW, y: textY, size: 11, font: this.fontBold,
      color: rgb(this.colors.primary.r, this.colors.primary.g, this.colors.primary.b)
    });
    textY -= 14;

    for (const line of ORG_CONFIG.address) {
      const lw = this.font.widthOfTextAtSize(line, 9);
      this.currentPage.drawText(line, {
        x: rightX - lw, y: textY, size: 9, font: this.font,
        color: rgb(this.colors.secondary.r, this.colors.secondary.g, this.colors.secondary.b)
      });
      textY -= 12;
    }

    const ww = this.font.widthOfTextAtSize(ORG_CONFIG.website, 9);
    this.currentPage.drawText(ORG_CONFIG.website, {
      x: rightX - ww, y: textY, size: 9, font: this.font,
      color: rgb(this.colors.accent.r, this.colors.accent.g, this.colors.accent.b)
    });

    this.currentY -= 80;
    this.drawLine();
  }

  drawTitle(title, subtitle) {
    this.addSpace(10);
    const tw = this.fontBold.widthOfTextAtSize(title, this.fonts.title);
    this.currentPage.drawText(title, {
      x: (PAGE_WIDTH - tw) / 2, y: this.currentY - this.fonts.title,
      size: this.fonts.title, font: this.fontBold,
      color: rgb(this.colors.primary.r, this.colors.primary.g, this.colors.primary.b)
    });
    this.currentY -= this.fonts.title + 10;

    if (subtitle) {
      const sw = this.fontBold.widthOfTextAtSize(subtitle, this.fonts.subheading);
      this.currentPage.drawText(subtitle, {
        x: (PAGE_WIDTH - sw) / 2, y: this.currentY - this.fonts.subheading,
        size: this.fonts.subheading, font: this.fontBold,
        color: rgb(this.colors.secondary.r, this.colors.secondary.g, this.colors.secondary.b)
      });
      this.currentY -= this.fonts.subheading + 15;
    }
  }

  drawSectionHeading(text) {
    this.addPageIfNeeded(40);
    this.currentY -= 15;
    this.currentPage.drawText(text, {
      x: this.margins.left, y: this.currentY - this.fonts.heading,
      size: this.fonts.heading, font: this.fontBold,
      color: rgb(this.colors.primary.r, this.colors.primary.g, this.colors.primary.b)
    });
    this.currentY -= this.fonts.heading + 5;
    this.currentPage.drawLine({
      start: { x: this.margins.left, y: this.currentY },
      end: { x: PAGE_WIDTH - this.margins.right, y: this.currentY },
      thickness: 1,
      color: rgb(this.colors.primary.r, this.colors.primary.g, this.colors.primary.b)
    });
    this.currentY -= 10;
  }

  drawField(label, value, options = {}) {
    const { bold = false, fontSize = this.fonts.body } = options;
    const sanitized = this._sanitize(value);
    const lineHeight = fontSize * 1.6;
    this.addPageIfNeeded(lineHeight);

    const font = bold ? this.fontBold : this.font;

    this.currentPage.drawText(this._sanitize(label) + ':', {
      x: this.margins.left + 5, y: this.currentY - fontSize,
      size: fontSize, font: this.fontBold,
      color: rgb(this.colors.secondary.r, this.colors.secondary.g, this.colors.secondary.b)
    });

    const labelWidth = this.fontBold.widthOfTextAtSize(this._sanitize(label) + ': ', fontSize);
    const valueX = this.margins.left + 5 + labelWidth;
    const maxValueWidth = this.contentWidth - labelWidth - 10;

    if (this.font.widthOfTextAtSize(sanitized, fontSize) <= maxValueWidth) {
      this.currentPage.drawText(sanitized, {
        x: valueX, y: this.currentY - fontSize,
        size: fontSize, font,
        color: rgb(this.colors.text.r, this.colors.text.g, this.colors.text.b)
      });
      this.currentY -= lineHeight;
    } else {
      this.currentY -= lineHeight;
      this.drawWrappedText(sanitized, this.margins.left + 20, this.contentWidth - 20);
    }
  }

  drawWrappedText(text, x, maxWidth, options = {}) {
    const { fontSize = this.fonts.body, font = this.font, color = this.colors.text, lineHeight = 1.3 } = options;
    if (!text || text.trim() === '') return 0;

    const words = text.split(/\s+/);
    const lines = [];
    let cur = '';

    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(test, fontSize) > maxWidth && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);

    const lh = fontSize * lineHeight;
    for (const line of lines) {
      if (this.currentY - lh < this.margins.bottom) this.addNewPage();
      this.currentPage.drawText(line, {
        x, y: this.currentY - fontSize, size: fontSize, font,
        color: rgb(color.r, color.g, color.b)
      });
      this.currentY -= lh;
    }
    return lines.length * lh;
  }

  // ========================================
  // Summary Table
  // ========================================

  drawSummaryTable(teachers) {
    const headers = ['Teacher Name', 'Email', 'Interview Date', 'Interview Place'];
    const rows = teachers.map(t => [
      `${t.firstName} ${t.lastName}`,
      t.email,
      t.interviewDate,
      _placeCountry(t.interviewPlace, t.interviewCountry)
    ]);

    const colWidths = [130, 170, 85, this.contentWidth - 385];
    const headerHeight = this.fonts.caption * 2;
    const rowHeight = this.fonts.caption * 2;
    const tableHeight = headerHeight + rows.length * rowHeight + 10;

    this.addPageIfNeeded(Math.min(tableHeight, 200));

    const startX = this.margins.left;
    let y = this.currentY;

    const _drawTableHeader = () => {
      const headerBg = this.colors.primary;
      this.currentPage.drawRectangle({
        x: startX, y: y - headerHeight, width: this.contentWidth, height: headerHeight,
        color: rgb(headerBg.r, headerBg.g, headerBg.b)
      });
      let hx = startX;
      for (let c = 0; c < headers.length; c++) {
        this.currentPage.drawText(this._sanitize(headers[c]), {
          x: hx + 4, y: y - headerHeight + 4,
          size: this.fonts.caption, font: this.fontBold,
          color: rgb(1, 1, 1)
        });
        hx += colWidths[c];
      }
      y -= headerHeight;
    };

    _drawTableHeader();

    // Data rows
    for (let r = 0; r < rows.length; r++) {
      if (y - rowHeight < this.margins.bottom) {
        this.addNewPage();
        y = this.currentY;
        _drawTableHeader();
      }

      if (r % 2 === 0) {
        this.currentPage.drawRectangle({
          x: startX, y: y - rowHeight, width: this.contentWidth, height: rowHeight,
          color: rgb(this.colors.lightGray.r, this.colors.lightGray.g, this.colors.lightGray.b)
        });
      }

      let x = startX;
      for (let c = 0; c < rows[r].length; c++) {
        const maxChars = Math.floor(colWidths[c] / (this.fonts.caption * 0.5)) - 1;
        const cellText = this._sanitize(rows[r][c]).substring(0, maxChars);
        this.currentPage.drawText(cellText, {
          x: x + 4, y: y - rowHeight + 4,
          size: this.fonts.caption, font: this.font,
          color: rgb(this.colors.text.r, this.colors.text.g, this.colors.text.b)
        });
        x += colWidths[c];
      }
      y -= rowHeight;
    }

    this.currentY = y - 10;
  }

  // ========================================
  // Generate
  // ========================================

  async generate(report, onProgress = () => {}) {
    onProgress('Initializing PDF...');
    await this.init();
    await this.drawOrgHeader();

    this.drawTitle('Recruiting Report', report.schoolName);

    // School contact
    onProgress('Adding school information...');
    this.drawField('Date', report.date);
    this.drawField('School Contact', `${report.schoolContactFirstName} ${report.schoolContactLastName}`);
    this.drawField('Contact Email', report.schoolContactEmail);

    // Summary table
    if (report.teachers.length > 0) {
      this.addSpace(5);
      this.drawSectionHeading('Teacher Summary');
      this.drawSummaryTable(report.teachers);
    }

    // Per-teacher sections
    for (let i = 0; i < report.teachers.length; i++) {
      const t = report.teachers[i];
      onProgress(`Adding teacher ${i + 1} of ${report.teachers.length}...`);

      this.drawSectionHeading(`Teacher ${i + 1}: ${t.firstName} ${t.lastName}`);
      this.drawField('Email', t.email);
      this.drawField('Interview Date', t.interviewDate);
      this.drawField('Interview Length', t.interviewLength);
      this.drawField('Interview Place', _placeCountry(t.interviewPlace, t.interviewCountry));

      if ((t.communicationVenues || []).length > 0) {
        this.drawField('Communication', _venueStr(t.communicationVenues, t.communicationOther));
      }

      // Additional interviewers
      if ((t.additionalInterviewers || []).length > 0) {
        this.addSpace(5);
        this.addPageIfNeeded(this.fonts.body * 1.6 + 5);
        this.currentPage.drawText('Additional School Interviewers:', {
          x: this.margins.left + 5, y: this.currentY - this.fonts.body,
          size: this.fonts.body, font: this.fontBold,
          color: rgb(this.colors.primary.r, this.colors.primary.g, this.colors.primary.b)
        });
        this.currentY -= this.fonts.body * 1.6;
        for (const iv of t.additionalInterviewers) {
          const ivText = iv.title ? `${iv.name} (${iv.title})` : iv.name;
          this.drawWrappedText(ivText, this.margins.left + 15, this.contentWidth - 15);
        }
      }

      // Prior employer references
      for (let r = 0; r < (t.references || []).length; r++) {
        const ref = t.references[r];
        if (!ref || !ref.name) continue;

        this.addSpace(5);
        this.currentPage.drawText(`Reference #${r + 1}`, {
          x: this.margins.left + 5, y: this.currentY - this.fonts.body,
          size: this.fonts.body, font: this.fontBold,
          color: rgb(this.colors.primary.r, this.colors.primary.g, this.colors.primary.b)
        });
        this.currentY -= this.fonts.body * 1.6;

        const refLine = [ref.name, ref.title ? `(${ref.title})` : '', ref.email ? `— ${ref.email}` : '']
          .filter(Boolean).join(' ');
        this.drawWrappedText(refLine, this.margins.left + 15, this.contentWidth - 15);

        if (ref.interviewDate) this.drawField('  Interview Date', ref.interviewDate);
        if (ref.interviewLength) this.drawField('  Interview Length', ref.interviewLength);
        if (ref.interviewPlace || ref.interviewCountry) this.drawField('  Place', _placeCountry(ref.interviewPlace, ref.interviewCountry));
        if ((ref.communicationVenues || []).length > 0) {
          this.drawField('  Communication', _venueStr(ref.communicationVenues, ref.communicationOther));
        }
      }

      // English test
      this.addSpace(5);
      if (t.isNativeEnglishSpeaker) {
        this.drawField('English', 'Native English speaker');
      } else {
        this.drawField('Native speaker tested English', t.nativeTestedEnglish ? 'Yes' : 'No');
        if (t.englishTestMinutes) {
          this.drawField('English test duration', `${t.englishTestMinutes} minutes`);
        }
      }
    }

    // Shared sections
    onProgress('Adding services & certification...');
    this.drawSectionHeading('Relocation Services');
    if (report.relocationCompany.hired) {
      this.drawField('Company', report.relocationCompany.name);
      this.drawField('Contact Email', report.relocationCompany.email);
    } else {
      this.drawField('Hired relocation company', 'No');
    }

    this.drawSectionHeading('Certification');
    if (report.certification.required) {
      this.drawField('Procedures Link', report.certification.link);
      this.drawField('Cost to Teacher', report.certification.costToTeacher);
    } else {
      this.drawField('Certification required', 'No (private/religious school)');
    }

    // Signature
    onProgress('Adding signature...');
    this.addSpace(20);
    this.drawLine();

    if (report.signature.imageDataUrl) {
      this.addPageIfNeeded(100);
      try {
        const sigData = report.signature.imageDataUrl.split(',')[1];
        const sigBytes = Uint8Array.from(atob(sigData), c => c.charCodeAt(0));
        const sigImage = await this.pdfDoc.embedPng(sigBytes);

        const maxW = 200, maxH = 80;
        const aspect = sigImage.width / sigImage.height;
        let w = maxW, h = w / aspect;
        if (h > maxH) { h = maxH; w = h * aspect; }

        this.currentPage.drawImage(sigImage, {
          x: this.margins.left, y: this.currentY - h, width: w, height: h
        });
        this.currentY -= h + 10;
      } catch (e) {
        console.warn('Could not embed signature:', e);
      }
    }

    this.drawField('Signed by', report.signature.signerName);
    this.drawField('Title', report.signature.signerTitle);

    // Embed report data as JSON in PDF metadata for import
    onProgress('Finalizing PDF...');
    const reportDataForEmbed = JSON.parse(JSON.stringify(report));
    delete reportDataForEmbed.signature.imageDataUrl;
    this.pdfDoc.setSubject(JSON.stringify(reportDataForEmbed));

    return await this.pdfDoc.save();
  }
}

export async function generatePDF(report, onProgress = () => {}) {
  const generator = new PDFGenerator();
  return await generator.generate(report, onProgress);
}

export function generateFilename(date, schoolName) {
  const sanitize = (str) => str.replace(/[^a-zA-Z0-9-_]/g, '_').replace(/_+/g, '_');
  return `Recruiting_Report_${sanitize(date)}_${sanitize(schoolName)}.pdf`;
}

export async function importReportFromPDF(file) {
  const buffer = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(buffer);
  const subject = pdfDoc.getSubject();
  if (!subject) return null;

  try {
    const data = JSON.parse(subject);
    if (!data.schoolName) return null;
    return data;
  } catch {
    return null;
  }
}

export function downloadPDF(pdfBytes, filename) {
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
