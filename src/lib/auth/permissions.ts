/**
 * Closed permission set and the four built-in roles.
 *
 * Two invariants are encoded here and enforced by tests:
 *
 *  1. No role — including ADMIN — has a permission that produces an
 *     admissions, hiring, or eligibility decision. That capability does not
 *     exist in this system, so it cannot be granted.
 *  2. `claim:decide` (recording a final verification status) is deliberately
 *     withheld from READ_ONLY_AUDITOR, and tips are readable only by roles that
 *     hold `tip:read`.
 */

export const PERMISSIONS = [
  'case:read',
  'case:create',
  'case:update',
  'case:assign',
  'case:close',

  'document:read',
  'document:upload',
  'document:download_original',
  'document:delete',

  'claim:read',
  'claim:edit',
  /** Record a final, human-authored verification status. */
  'claim:decide',

  'evidence:read',
  'evidence:create',

  'sourcecheck:run',

  'discrepancy:read',
  'discrepancy:resolve',

  'outreach:draft',
  /** Approve an outreach draft. The system still never transmits it. */
  'outreach:approve',
  'outreach:record_response',

  'clarification:draft',
  'clarification:approve',

  'interview:manage',

  'tip:read',
  'tip:triage',

  'report:export',

  'audit:read',

  'admin:users',
  'admin:policies',
  'admin:retention',
  'admin:settings',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_KEYS = ['ADMIN', 'LEAD_REVIEWER', 'REVIEWER', 'READ_ONLY_AUDITOR'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

const REVIEWER_PERMISSIONS: Permission[] = [
  'case:read',
  'case:update',
  'document:read',
  'document:upload',
  'document:download_original',
  'claim:read',
  'claim:edit',
  'claim:decide',
  'evidence:read',
  'evidence:create',
  'sourcecheck:run',
  'discrepancy:read',
  'discrepancy:resolve',
  'outreach:draft',
  'outreach:record_response',
  'clarification:draft',
  'interview:manage',
  'report:export',
  'audit:read',
];

const LEAD_REVIEWER_PERMISSIONS: Permission[] = [
  ...REVIEWER_PERMISSIONS,
  'case:create',
  'case:assign',
  'case:close',
  'document:delete',
  // Only leads may authorise contact with a third party or the applicant.
  'outreach:approve',
  'clarification:approve',
  'tip:read',
  'tip:triage',
];

const AUDITOR_PERMISSIONS: Permission[] = [
  'case:read',
  'document:read',
  'claim:read',
  'evidence:read',
  'discrepancy:read',
  'report:export',
  'audit:read',
];

export const ROLE_DEFINITIONS: Record<
  RoleKey,
  { name: string; description: string; permissions: Permission[] }
> = {
  ADMIN: {
    name: 'Administrator',
    description:
      'Manages users, policy templates, retention rules, and settings. Holds reviewer permissions as well.',
    permissions: [
      ...LEAD_REVIEWER_PERMISSIONS,
      'admin:users',
      'admin:policies',
      'admin:retention',
      'admin:settings',
    ],
  },
  LEAD_REVIEWER: {
    name: 'Lead reviewer',
    description:
      'Full case work plus authority to approve outreach and applicant clarification requests, and to triage anonymous tips.',
    permissions: LEAD_REVIEWER_PERMISSIONS,
  },
  REVIEWER: {
    name: 'Reviewer',
    description:
      'Works assigned cases: edits claims, runs source checks, records verification statuses, drafts outreach for approval.',
    permissions: REVIEWER_PERMISSIONS,
  },
  READ_ONLY_AUDITOR: {
    name: 'Read-only auditor',
    description:
      'Reads cases, evidence, and the audit trail, and exports reports. Cannot alter any record or view anonymous tips.',
    permissions: AUDITOR_PERMISSIONS,
  },
};

export function permissionsFor(role: RoleKey): Permission[] {
  return [...ROLE_DEFINITIONS[role].permissions];
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
