import { getEnv } from '@/lib/env';
import { UnsupportedDocumentError, type DocumentProcessor, type ProcessedDocument } from './types';
import { TextDocumentProcessor } from './text';
import { PdfDocumentProcessor } from './pdf';
import { MockOcrDocumentProcessor } from './mockOcr';

export type { DocumentProcessor, ProcessedDocument, DocumentPageText } from './types';
export { UnsupportedDocumentError } from './types';

const REGISTRY: Record<string, () => DocumentProcessor> = {
  text: () => new TextDocumentProcessor(),
  pdf: () => new PdfDocumentProcessor(),
  'mock-ocr': () => new MockOcrDocumentProcessor(),
};

let chain: DocumentProcessor[] | null = null;

/** Ordered processor chain from DOCUMENT_PROCESSORS; first match wins. */
export function getDocumentProcessors(): DocumentProcessor[] {
  if (chain) return chain;

  chain = getEnv()
    .DOCUMENT_PROCESSORS.split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((key) => {
      const factory = REGISTRY[key];
      if (!factory) throw new Error(`Unknown document processor "${key}" in DOCUMENT_PROCESSORS`);
      return factory();
    });

  return chain;
}

export function resetDocumentProcessorCache(): void {
  chain = null;
}

export async function processDocument(bytes: Buffer, mimeType: string, filename: string): Promise<ProcessedDocument> {
  const processor = getDocumentProcessors().find((p) => p.supports(mimeType, filename));
  if (!processor) throw new UnsupportedDocumentError(mimeType);
  return processor.process(bytes, filename);
}
