import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { createLogger } from '../logger.js';

const logger = createLogger('files');

export interface ProcessedFile {
  name: string;
  type: string;
  content: string;
}

export async function processFile(name: string, dataUrl: string): Promise<ProcessedFile> {
  const [header, base64Data] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] || '';
  const buffer = Buffer.from(base64Data, 'base64');

  logger.info(`Processing file: ${name} (${mime})`);

  try {
    if (mime.startsWith('image/')) {
      return { name, type: mime, content: '[Image data attached]' };
    }

    if (mime === 'application/pdf') {
      const data = await pdf(buffer);
      return { name, type: mime, content: data.text };
    }

    if (mime.includes('word') || name.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer });
      return { name, type: mime, content: result.value };
    }

    if (mime.includes('sheet') || name.endsWith('.xlsx') || name.endsWith('.csv')) {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const csv = XLSX.utils.sheet_to_csv(worksheet);
      return { name, type: mime, content: csv };
    }

    if (mime.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) {
      return { name, type: mime, content: buffer.toString('utf8') };
    }

    return { name, type: mime, content: `[Unsupported file format: ${mime}]` };
  } catch (error: any) {
    logger.error({ name, error: error.message }, 'Failed to process file');
    return { name, type: mime, content: `[Error reading file ${name}: ${error.message}]` };
  }
}
