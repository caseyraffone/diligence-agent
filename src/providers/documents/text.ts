import type { DocumentProcessor, ProcessedDocument } from './types';

/**
 * Plain-text and Markdown processor.
 *
 * Pages are split on form feeds when present, otherwise on a blank-line
 * "--- page N ---" marker, otherwise the whole file is page 1. Seed fixtures use
 * the marker so citations in the demonstration cases point at real page numbers.
 */
export class TextDocumentProcessor implements DocumentProcessor {
  readonly key = 'text';

  supports(mimeType: string, filename: string): boolean {
    return (
      mimeType.startsWith('text/') || mimeType === 'application/json' || /\.(txt|md|markdown|csv)$/i.test(filename)
    );
  }

  async process(bytes: Buffer, _filename: string): Promise<ProcessedDocument> {
    const raw = bytes.toString('utf8');

    let chunks: string[];
    if (raw.includes('\f')) {
      chunks = raw.split('\f');
    } else if (/^---\s*page\s+\d+\s*---$/im.test(raw)) {
      chunks = raw.split(/^---\s*page\s+\d+\s*---$/gim).filter((c) => c.trim().length > 0);
    } else {
      chunks = [raw];
    }

    const pages = chunks.map((text, index) => ({ pageNumber: index + 1, text: text.trim() }));

    return {
      pages: pages.length > 0 ? pages : [{ pageNumber: 1, text: '' }],
      metadata: {
        byteLength: bytes.byteLength,
        lineCount: raw.split('\n').length,
        encoding: 'utf8',
      },
      processor: this.key,
    };
  }
}
