import { and, eq, ne } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db, schema } from '../db/index.js';
import type { Subscription } from '../db/schema.js';
import type { SubscriptionStatus } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface CreateSubscriptionInput {
  user_id: string;
  api_id: number;
  metering_limit?: number | null;
}

export interface UpdateSubscriptionInput {
  status?: SubscriptionStatus;
  metering_limit?: number | null;
}

export interface SubscriptionRepository {
  create(data: CreateSubscriptionInput): Promise<Subscription>;
  findById(id: string): Promise<Subscription | undefined>;
  findByUserId(user_id: string): Promise<Subscription[]>;
  findActiveByUserAndApi(user_id: string, api_id: number): Promise<Subscription | undefined>;
  update(id: string, data: UpdateSubscriptionInput): Promise<Subscription | undefined>;
  cancel(id: string): Promise<Subscription | undefined>;
}

// ---------------------------------------------------------------------------
// Default (SQLite / Drizzle) implementation
// ---------------------------------------------------------------------------

async function create(data: CreateSubscriptionInput): Promise<Subscription> {
  const id = randomUUID();
  const now = new Date();

  const [inserted] = await db
    .insert(schema.subscriptions)
    .values({
      id,
      user_id: data.user_id,
      api_id: data.api_id,
      status: 'active',
      metering_limit: data.metering_limit ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning();

  if (!inserted) throw new Error('Subscription insert failed');
  return inserted;
}

async function findById(id: string): Promise<Subscription | undefined> {
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.id, id))
    .limit(1);
  return rows[0];
}

async function findByUserId(user_id: string): Promise<Subscription[]> {
  return db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.user_id, user_id))
    .orderBy(schema.subscriptions.created_at);
}

async function findActiveByUserAndApi(
  user_id: string,
  api_id: number,
): Promise<Subscription | undefined> {
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.user_id, user_id),
        eq(schema.subscriptions.api_id, api_id),
        ne(schema.subscriptions.status, 'cancelled'),
      ),
    )
    .limit(1);
  return rows[0];
}

async function update(
  id: string,
  data: UpdateSubscriptionInput,
): Promise<Subscription | undefined> {
  const now = new Date();

  const [updated] = await db
    .update(schema.subscriptions)
    .set({
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.metering_limit !== undefined ? { metering_limit: data.metering_limit } : {}),
      updated_at: now,
    })
    .where(eq(schema.subscriptions.id, id))
    .returning();

  return updated;
}

async function cancel(id: string): Promise<Subscription | undefined> {
  const now = new Date();

  const [updated] = await db
    .update(schema.subscriptions)
    .set({
      status: 'cancelled',
      cancelled_at: now,
      updated_at: now,
    })
    .where(eq(schema.subscriptions.id, id))
    .returning();

  return updated;
}

export const defaultSubscriptionRepository: SubscriptionRepository = {
  create,
  findById,
  findByUserId,
  findActiveByUserAndApi,
  update,
  cancel,
};
