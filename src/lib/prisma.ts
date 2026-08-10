import { PrismaClient } from '@prisma/client';

declare global {
  var __diligencePrisma: PrismaClient | undefined;
}

function create(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

/**
 * Single client per process. Next's dev server re-evaluates modules on each
 * change, which would otherwise exhaust the connection pool.
 */
export const prisma: PrismaClient = globalThis.__diligencePrisma ?? create();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__diligencePrisma = prisma;
}

export type { PrismaClient };
export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
