import type { DocumentProcessor, ProcessedDocument } from './types';

/**
 * PDF text extraction via pdfjs-dist.
 *
 * Extracts the embedded text layer only. A scanned PDF with no text layer
 * yields empty pages, which is correct behaviour: this processor reports what
 * it can read, and the empty result routes the document to OCR rather than
 * silently producing nothing.
 */
export class PdfDocumentProcessor implements DocumentProcessor {
  readonly key = 'pdf';

  supports(mimeType: string, filename: string): boolean {
    return mimeType === 'application/pdf' || /\.pdf$/i.test(filename);
  }

  async process(bytes: Buffer, _filename: string): Promise<ProcessedDocument> {
    // Loaded lazily and via the legacy build: pdfjs's modern entry expects
    // browser globals that are absent in the Node server runtime.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      // Untrusted input: never let a document pull remote resources or run
      // embedded JavaScript during parsing.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    });

    const doc = await loadingTask.promise;
    const pages: ProcessedDocument['pages'] = [];

    try {
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();

        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim();

        pages.push({ pageNumber, text });
        page.cleanup();
      }

      const info = await doc.getMetadata().catch(() => null);
      const rawInfo = (info?.info ?? {}) as Record<string, unknown>;

      return {
        pages,
        // Observations only. A mismatched producer or an odd modification date
        // is a reason for a human to look, never a finding of alteration.
        metadata: {
          pageCount: doc.numPages,
          producer: String(rawInfo['Producer'] ?? ''),
          creator: String(rawInfo['Creator'] ?? ''),
          creationDate: String(rawInfo['CreationDate'] ?? ''),
          modificationDate: String(rawInfo['ModDate'] ?? ''),
          pdfVersion: String(rawInfo['PDFFormatVersion'] ?? ''),
          isEncrypted: Boolean(rawInfo['IsEncrypted'] ?? false),
          hasTextLayer: pages.some((p) => p.text.length > 0),
        },
        processor: this.key,
      };
    } finally {
      await doc.destroy();
    }
  }
}
