import { NextResponse } from 'next/server';
import PDFDocument from 'pdfkit';
import { requirePermission } from '@/lib/auth/context';
import { loadCase } from '@/lib/auth/tenant';
import { buildCaseReport, type CaseReport, type ReportEvidenceLine } from '@/modules/caseReviewer';
import { recordAudit } from '@/lib/audit/audit';
import { isAppError } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Neutral PDF report.
 *
 * The structure mirrors the on-screen report deliberately: the five categories
 * of information stay separated, and the standing notice about what this
 * document is — and is not — appears on the first page, before any finding.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePermission('report:export');
    const { id } = await context.params;
    const record = await loadCase(actor, id);
    const report = await buildCaseReport(id, actor.organizationId);

    await recordAudit({
      organizationId: actor.organizationId,
      caseId: id,
      actorType: 'USER',
      actorUserId: actor.userId,
      action: 'REPORT_EXPORTED',
      entityType: 'Case',
      entityId: id,
      metadata: { format: 'pdf' },
    });

    const pdf = await renderPdf(report);

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${record.reference}-verification-report.pdf"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    if (isAppError(e)) {
      return NextResponse.json({ error: e.publicMessage }, { status: e.status });
    }
    throw e;
  }
}

function renderPdf(report: CaseReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Core fonts only — no font files are loaded from disk, which keeps this
    // working in a minimal container.
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, font: 'Helvetica' });
    const chunks: Buffer[] = [];

    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const H1 = 16;
    const H2 = 12;
    const BODY = 9.5;

    doc.font('Helvetica-Bold').fontSize(H1).text('Verification report', { align: 'left' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(BODY).fillColor('#444');
    doc.text(`${report.case.reference} — ${report.case.title}`);
    doc.text(`Applicant: ${report.case.applicantName}`);
    doc.text(`Policy: ${report.case.policy}`);
    doc.text(`Reviewer: ${report.case.assignedReviewer ?? 'unassigned'}`);
    doc.text(`Generated: ${report.generatedAt}`);
    doc.fillColor('#000');
    doc.moveDown(0.8);

    // The notice comes before any content, on purpose.
    doc.rect(50, doc.y, doc.page.width - 100, 0).stroke('#cccccc');
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(H2).text('About this report');
    doc.font('Helvetica').fontSize(BODY).text(report.notice, { align: 'left' });
    doc.moveDown(0.8);

    doc.font('Helvetica-Bold').fontSize(H2).text('Summary');
    doc.font('Helvetica').fontSize(BODY);
    doc.text(`Claims extracted: ${report.summary.totalClaims}`);
    doc.text(`Claims with an outcome recorded: ${report.summary.percentReviewed}%`);
    doc.text(`Unresolved differences: ${report.summary.openDiscrepancies}`);
    doc.text(
      `Audit chain: ${report.auditIntegrity.valid ? 'intact' : `BROKEN — ${report.auditIntegrity.reason}`} ` +
        `(${report.auditIntegrity.eventsChecked} events verified)`,
    );
    doc.moveDown(0.8);

    doc.font('Helvetica-Bold').fontSize(H2).text('Claims and recorded outcomes');
    doc.font('Helvetica').fontSize(BODY);
    for (const claim of report.claims) {
      if (doc.y > doc.page.height - 130) doc.addPage();
      doc.font('Helvetica-Bold').text(claim.claim);
      doc.font('Helvetica').fillColor('#444');
      doc.text(`Status: ${claim.status.replace(/_/g, ' ').toLowerCase()} — ${claim.statusMeaning}`);
      doc.text(`Source: ${claim.citation} · Dates: ${claim.dates}`);
      if (claim.humanDecision) {
        doc.text(
          `Recorded by ${claim.humanDecision.by} on ${claim.humanDecision.at}: ${claim.humanDecision.rationale}`,
        );
      } else {
        doc.text('No human decision has been recorded for this claim.');
      }
      doc.fillColor('#000').moveDown(0.5);
    }

    const section = (title: string, explanation: string, lines: ReportEvidenceLine[]): void => {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(H2).text(`${title} (${lines.length})`);
      doc.font('Helvetica').fontSize(BODY).fillColor('#444').text(explanation);
      doc.fillColor('#000').moveDown(0.4);
      if (lines.length === 0) {
        doc.text('Nothing in this category.');
        return;
      }
      for (const line of lines) {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.font('Helvetica-Bold').text(line.claim);
        doc.font('Helvetica').text(line.summary);
        if (line.detail) doc.fillColor('#444').text(line.detail).fillColor('#000');
        doc
          .fillColor('#666')
          .fontSize(8)
          .text(
            `${line.authority}${line.source ? ` · ${line.source}` : ''}${line.retrievedAt ? ` · retrieved ${line.retrievedAt}` : ''}`,
          );
        doc.fillColor('#000').fontSize(BODY).moveDown(0.4);
      }
    };

    section(
      'Confirmed facts',
      'Confirmed by an issuing authority, an official record, or an authorised representative.',
      report.confirmedFacts,
    );
    section(
      'Applicant statements',
      'What the applicant told us. Recorded as their account, not as established fact.',
      report.applicantStatements,
    );
    section(
      'Third-party statements',
      'What referees, employers, and other outside parties said, attributed to them.',
      report.thirdPartyStatements,
    );
    section(
      'System observations',
      'Things the software noticed, including searches that returned no record. An observation is not a finding, and a search returning nothing is not evidence about a claim.',
      report.systemObservations,
    );
    section(
      'Inferences',
      'Reasoning drawn from the material above rather than stated by any source.',
      report.inferences,
    );

    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(H2).text(`Unresolved differences (${report.unresolvedDiscrepancies.length})`);
    doc.font('Helvetica').fontSize(BODY);
    if (report.unresolvedDiscrepancies.length === 0) {
      doc.text('None outstanding.');
    } else {
      for (const d of report.unresolvedDiscrepancies) {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.font('Helvetica-Bold').text(d.title);
        doc.font('Helvetica').text(d.description);
        doc.moveDown(0.4);
      }
    }

    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(H2).text('Applicant clarification history');
    doc.font('Helvetica').fontSize(BODY);
    if (report.clarifications.length === 0) {
      doc.text('No clarification requests were sent.');
    } else {
      for (const c of report.clarifications) {
        doc.text(`${c.subject} — ${c.status.toLowerCase()}, ${c.responses} response(s)`);
      }
    }

    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(H2).text('Timeline');
    doc.font('Helvetica').fontSize(BODY);
    for (const t of report.timeline) {
      doc.text(`${t.dates} — ${t.label}${t.organization ? `, ${t.organization}` : ''}`);
    }

    // Footer on every page.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(7.5).fillColor('#666');
      doc.text(
        `${report.case.reference} · page ${i + 1} of ${range.count} · Decision-support only — not an admissions, hiring, or eligibility decision.`,
        50,
        doc.page.height - 40,
        { width: doc.page.width - 100, align: 'center' },
      );
    }

    doc.end();
  });
}
