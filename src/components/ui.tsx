import { ClaimStatus, DiscrepancySeverity, DiscrepancyStatus, SourceCheckResult } from '@prisma/client';
import { STATUS_LABELS } from '@/domain/claimStatus';

/**
 * Shared presentational pieces.
 *
 * Status is never conveyed by colour alone: every pill renders its text label,
 * so the meaning survives greyscale, colour blindness, and screen readers.
 */

type PillTone = 'ok' | 'warn' | 'conflict' | 'neutral' | 'info';

export function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

const STATUS_TONE: Record<ClaimStatus, PillTone> = {
  [ClaimStatus.VERIFIED]: 'ok',
  [ClaimStatus.CORROBORATED]: 'ok',
  [ClaimStatus.PARTIALLY_CORROBORATED]: 'info',
  [ClaimStatus.PENDING_VERIFICATION]: 'neutral',
  // "Unable to verify" is deliberately neutral, not a warning colour: it is an
  // evidence gap, and colouring it as a problem would prime the reviewer.
  [ClaimStatus.UNABLE_TO_VERIFY]: 'neutral',
  [ClaimStatus.CONFLICTING_INFORMATION]: 'conflict',
  [ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED]: 'info',
  [ClaimStatus.HUMAN_REVIEW_REQUIRED]: 'warn',
};

export function StatusPill({ status }: { status: ClaimStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Pill>;
}

const RESULT_TONE: Record<SourceCheckResult, PillTone> = {
  [SourceCheckResult.MATCH]: 'ok',
  [SourceCheckResult.PARTIAL_MATCH]: 'info',
  [SourceCheckResult.NO_MATCH]: 'conflict',
  [SourceCheckResult.RECORD_NOT_FOUND]: 'neutral',
  [SourceCheckResult.SOURCE_UNAVAILABLE]: 'neutral',
  [SourceCheckResult.INCONCLUSIVE]: 'neutral',
  [SourceCheckResult.ERROR]: 'warn',
};

const RESULT_LABEL: Record<SourceCheckResult, string> = {
  [SourceCheckResult.MATCH]: 'Match',
  [SourceCheckResult.PARTIAL_MATCH]: 'Partial match',
  [SourceCheckResult.NO_MATCH]: 'Record differs',
  [SourceCheckResult.RECORD_NOT_FOUND]: 'No record held',
  [SourceCheckResult.SOURCE_UNAVAILABLE]: 'Source unavailable',
  [SourceCheckResult.INCONCLUSIVE]: 'Inconclusive',
  [SourceCheckResult.ERROR]: 'Error',
};

export function ResultPill({ result }: { result: SourceCheckResult }) {
  return <Pill tone={RESULT_TONE[result]}>{RESULT_LABEL[result]}</Pill>;
}

const SEVERITY_TONE: Record<DiscrepancySeverity, PillTone> = {
  [DiscrepancySeverity.INFORMATIONAL]: 'neutral',
  [DiscrepancySeverity.REVIEW_SUGGESTED]: 'info',
  [DiscrepancySeverity.REVIEW_REQUIRED]: 'warn',
};

const SEVERITY_LABEL: Record<DiscrepancySeverity, string> = {
  [DiscrepancySeverity.INFORMATIONAL]: 'For information',
  [DiscrepancySeverity.REVIEW_SUGGESTED]: 'Review suggested',
  [DiscrepancySeverity.REVIEW_REQUIRED]: 'Review required',
};

export function SeverityPill({ severity }: { severity: DiscrepancySeverity }) {
  return <Pill tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Pill>;
}

const DISCREPANCY_STATUS_LABEL: Record<DiscrepancyStatus, string> = {
  [DiscrepancyStatus.OPEN]: 'Open',
  [DiscrepancyStatus.UNDER_REVIEW]: 'Under review',
  [DiscrepancyStatus.EXPLAINED]: 'Explained',
  [DiscrepancyStatus.RESOLVED]: 'Resolved',
  [DiscrepancyStatus.DISMISSED_NOT_AN_ISSUE]: 'Not an issue',
};

export function DiscrepancyStatusPill({ status }: { status: DiscrepancyStatus }) {
  const tone: PillTone =
    status === DiscrepancyStatus.OPEN ? 'warn' : status === DiscrepancyStatus.UNDER_REVIEW ? 'info' : 'ok';
  return <Pill tone={tone}>{DISCREPANCY_STATUS_LABEL[status]}</Pill>;
}

export function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/**
 * The standing reminder of what this tool is. Rendered on the dashboard, every
 * case, and every report, because the boundary matters most when someone is
 * deep in a case and has stopped reading headers.
 */
export function DecisionSupportNotice() {
  return (
    <div className="notice" role="note">
      <strong>Decision-support only</strong>
      This system gathers and organises evidence for a trained human reviewer. It does not determine whether a
      statement is true, does not allege dishonesty, and produces no admissions, hiring, or eligibility decision.
      “Unable to verify” means no record was found through the channels available — it is not evidence that a claim
      is inaccurate.
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="muted small" style={{ padding: '0.75rem 0' }}>
      {children}
    </p>
  );
}

export function formatDate(date: Date | string | null): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString().slice(0, 10);
}

export function formatDateTime(date: Date | string | null): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}
