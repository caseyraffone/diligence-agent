import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { describeProviderPosture } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Liveness and configuration posture.
 *
 * Deliberately exposes no secrets, no counts of applicant data, and no tenant
 * names — only whether the process can reach its database and which providers
 * are configured.
 */
export async function GET() {
  const posture = describeProviderPosture();

  let database = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'unreachable';
  }

  return NextResponse.json(
    {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      llmProvider: posture.provider,
      llmModel: posture.model,
      paidProviderActive: posture.isPaid,
      liveSourcesEnabled: posture.liveSourcesEnabled,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
