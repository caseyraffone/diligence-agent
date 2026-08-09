/**
 * Document processing (text extraction / OCR) abstraction.
 *
 * Implementations return page-addressable text so every extracted claim can
 * cite the document and page it came from — the citation is what lets a
 * reviewer check the system's reading against the original.
 */

export interface DocumentPageText {
  pageNumber: number;
  text: string;
}

export interface ProcessedDocument {
  pages: DocumentPageText[];
  /**
   * Observable, non-conclusive facts about the file: producer software,
   * creation/modification timestamps, page-size irregularities. These are shown
   * to reviewers as observations. They NEVER establish that a document was
   * altered — see LIMITATIONS.md.
   */
  metadata: Record<string, string | number | boolean>;
  processor: string;
}

export interface DocumentProcessor {
  readonly key: string;
  /** Whether this processor handles the given mime type / filename. */
  supports(mimeType: string, filename: string): boolean;
  process(bytes: Buffer, filename: string): Promise<ProcessedDocument>;
}

export class UnsupportedDocumentError extends Error {
  constructor(mimeType: string) {
    super(`No document processor is configured for ${mimeType}`);
    this.name = 'UnsupportedDocumentError';
  }
}
