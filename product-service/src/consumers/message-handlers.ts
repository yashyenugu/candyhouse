import mongoose from 'mongoose';
import { ZodError } from 'zod';
import CandyModel from '@/models/candy.model';
import ProcessedEventModel from '@/models/processed-event.model';
import { UserModel } from '@/models/user.model';
import { candyQuantityUpdateSchema } from '@/utils/schemas/candy';
import { userSchema } from '@/utils/schemas/user';

// A failure that retrying cannot fix (malformed payload, unknown candy). It goes straight to the DLQ.
export class PermanentError extends Error {}

export const isPermanentError = (error: unknown): boolean =>
  error instanceof PermanentError || error instanceof ZodError || error instanceof SyntaxError;

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

export type QuantityResult = 'applied' | 'duplicate';

// Applies a stock delta at most once per event id. The id insert and the $inc commit in one
// transaction, so a crash can neither double-apply nor drop an event. Needs a replica set.
// Events without an id (published before ids existed) are applied without deduplication.
export const handleQuantityMessage = async (key: string | undefined, value: string, eventId?: string): Promise<QuantityResult> => {
  if (!key) throw new PermanentError('quantity message has no key (candy appId)');
  const { quantity } = candyQuantityUpdateSchema.parse(JSON.parse(value));

  if (!eventId) {
    console.warn(`quantity event for ${key} has no eventId; applying without deduplication`);
    const result = await CandyModel.updateOne({ appId: key }, { $inc: { quantity } });
    if (result.matchedCount === 0) throw new PermanentError(`quantity event for unknown candy ${key}`);
    return 'applied';
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ProcessedEventModel.create([{ eventId }], { session });
      const result = await CandyModel.updateOne({ appId: key }, { $inc: { quantity } }, { session });
      if (result.matchedCount === 0) throw new PermanentError(`quantity event for unknown candy ${key}`);
    });
    return 'applied';
  } catch (error) {
    // The id was already recorded: this is a redelivery (or a concurrent twin that won the race).
    if (isDuplicateKey(error)) return 'duplicate';
    throw error;
  } finally {
    await session.endSession();
  }
};

// Idempotent already: an upsert keyed by appId.
export const handleUserMessage = async (value: string): Promise<void> => {
  const { appId, balance, email, name, role, totalEarnedCoins, totalRedeemedCoins } = userSchema.parse(JSON.parse(value));
  await UserModel.findOneAndUpdate({ appId }, { balance, email, name, role, totalEarnedCoins, totalRedeemedCoins }, { upsert: true });
};
