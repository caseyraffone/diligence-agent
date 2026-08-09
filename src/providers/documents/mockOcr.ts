import type { DocumentProcessor, ProcessedDocument } from './types';

/**
 * Placeholder OCR processor for images and scanned PDFs.
 *
 * It performs NO optical character recognition. It records that a human-readable
 * document was received which the system cannot read, so the workflow routes it
 * to a reviewer instead of treating an image as an empty document. Silently
 * yielding no claims from a scanned transcript would be the dangerous failure
 * mode here.
 *
 * INTEGRATION PLACEHOLDER — production OCR.
 * Implement `DocumentProcessor` against a real engine (Tesseract locally, or a
 * cloud document-AI service). A cloud engine sends applicant documents to a
 * third party and therefore requires a data-processing agreement, a lawful
 * basis, and disclosure in the applicant privacy notice before it is enabled.
 */
export class MockOcrDocumentProcessor implements DocumentProcessor {
  readonly key = 'mock-ocr';

  supports(mimeType: string, filename: string): boolean {
    return mimeType.startsWith('image/') || /\.(png|jpe?g|tiff?|heic|webp|gif|bmp)$/i.test(filename);
  }

  async process(bytes: Buffer, filename: string): Promise<ProcessedDocument> {
    return {
      pages: [
        {
          pageNumber: 1,
          text:
            `[No text could be extracted from ${filename}.]\n\n` +
            'This file is an image. Optical character recognition is not configured in this deployment, ' +
            'so no claims were extracted from it. This is a processing limitation and says nothing about ' +
            'the document or the applicant. A reviewer should open the original and enter any claims manually.',
        },
      ],
      metadata: {
        byteLength: bytes.byteLength,
        ocrPerformed: false,
        requiresManualReview: true,
      },
      processor: this.key,
    };
  }
}
