import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RegisteredPdfFonts {
  fontRegular: string;
  fontBold: string;
  fontItalic: string;
  fontBoldItalic: string;
  hasUnicode: boolean;
}

function resolveFontPath(fontFilename: string, windowsFallback: string): string | null {
  const candidates = [
    path.join(__dirname, '../assets/fonts', fontFilename),
    path.join(process.cwd(), 'src/assets/fonts', fontFilename),
    path.join(process.cwd(), 'dist/assets/fonts', fontFilename),
    windowsFallback,
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function registerUnicodeFonts(doc: PDFKit.PDFDocument): RegisteredPdfFonts {
  const regPath = resolveFontPath('times.ttf', 'C:\\Windows\\Fonts\\times.ttf');
  const boldPath = resolveFontPath('timesbd.ttf', 'C:\\Windows\\Fonts\\timesbd.ttf');
  const italicPath = resolveFontPath('timesi.ttf', 'C:\\Windows\\Fonts\\timesi.ttf');
  const boldItalicPath = resolveFontPath('timesbi.ttf', 'C:\\Windows\\Fonts\\timesbi.ttf');

  const hasUnicode = Boolean(regPath && boldPath);

  if (hasUnicode && regPath && boldPath) {
    try {
      doc.registerFont('Times-Unicode-Regular', regPath);
      doc.registerFont('Times-Unicode-Bold', boldPath);
      if (italicPath) doc.registerFont('Times-Unicode-Italic', italicPath);
      if (boldItalicPath) doc.registerFont('Times-Unicode-BoldItalic', boldItalicPath);

      return {
        fontRegular: 'Times-Unicode-Regular',
        fontBold: 'Times-Unicode-Bold',
        fontItalic: italicPath ? 'Times-Unicode-Italic' : 'Times-Italic',
        fontBoldItalic: boldItalicPath ? 'Times-Unicode-BoldItalic' : 'Times-BoldItalic',
        hasUnicode: true,
      };
    } catch (err) {
      console.warn('Failed to register TrueType fonts with PDFKit, falling back to standard PostScript fonts:', err);
    }
  }

  return {
    fontRegular: 'Times-Roman',
    fontBold: 'Times-Bold',
    fontItalic: 'Times-Italic',
    fontBoldItalic: 'Times-BoldItalic',
    hasUnicode: false,
  };
}

export function formatPdfCurrency(amount: number | string | undefined | null, hasUnicode: boolean): string {
  const num = typeof amount === 'number' ? amount : parseFloat(String(amount || '0')) || 0;
  const formatted = num.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if (hasUnicode) {
    return `₹ ${formatted}`;
  }
  return `Rs. ${formatted}`;
}
