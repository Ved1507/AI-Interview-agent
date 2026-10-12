/**
 * CV text extraction for PDF and DOCX uploads.
 * The file type is checked from the file's signature bytes, not the extension alone.
 * Scanned, image-only files have no text layer and are rejected (no OCR).
 */

// Loaded with require: the packages ship no TypeScript declarations.
const { PDFParse } = require('pdf-parse');
const mammoth: { extractRawText(input: { buffer: Buffer }): Promise<{ value: string }> } = require('mammoth');

/** Text of every page in a PDF. Version 1.x of pdf-parse rejected some valid PDFs, so 2.x is used. */
async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy?.();
  }
}

export const CV_MAX_BYTES = 5 * 1024 * 1024;
const MIN_TEXT_CHARS = 40;

export type CvFileType = 'pdf' | 'docx';

export function detectCvType(buffer: Buffer, filename: string): CvFileType {
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF') {
    return 'pdf';
  }

  // DOCX is a ZIP container
  const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  if (isZip && filename.toLowerCase().endsWith('.docx')) {
    return 'docx';
  }

  // Legacy Word .doc uses the OLE2 container
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') {
    throw new Error('Old .doc files are not supported. Save the CV as .docx or PDF.');
  }

  throw new Error('Unsupported file. Upload a PDF or DOCX CV.');
}

function normalize(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractCvText(buffer: Buffer, filename: string): Promise<{ text: string; fileType: CvFileType }> {
  if (buffer.length === 0) {
    throw new Error('The uploaded file is empty.');
  }
  if (buffer.length > CV_MAX_BYTES) {
    throw new Error('The CV file is larger than 5 MB.');
  }

  const fileType = detectCvType(buffer, filename);

  let raw: string;
  try {
    if (fileType === 'pdf') {
      // Drop the "-- 1 of 3 --" page markers the parser adds between pages
      raw = (await pdfText(buffer)).replace(/^-- \d+ of \d+ --$/gm, '');
    } else {
      const parsed = await mammoth.extractRawText({ buffer });
      raw = parsed.value;
    }
  } catch (error) {
    // Keep parser internals out of the user-facing message
    throw new Error(`The ${fileType.toUpperCase()} file could not be read. Check that it is not damaged or password-protected.`);
  }

  const text = normalize(raw);
  if (text.length < MIN_TEXT_CHARS) {
    throw new Error('No readable text was found. Scanned or image-only CVs are not supported; upload a text-based PDF or DOCX.');
  }

  return { text, fileType };
}
