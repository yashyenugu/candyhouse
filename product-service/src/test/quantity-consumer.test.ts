import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import CandyModel from '@/models/candy.model';
import ProcessedEventModel from '@/models/processed-event.model';
import { handleQuantityMessage, handleUserMessage, isPermanentError } from '@/consumers/message-handlers';

let replset: MongoMemoryReplSet;

const quantityOf = async (appId: string) => (await CandyModel.findOne({ appId }))?.quantity;
const delta = (quantity: number) => JSON.stringify({ quantity });

beforeAll(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri());
  await Promise.all([CandyModel.init(), ProcessedEventModel.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replset.stop();
});

beforeEach(async () => {
  await Promise.all([CandyModel.deleteMany({}), ProcessedEventModel.deleteMany({})]);
  await CandyModel.create({
    name: 'gummy',
    description: 'd',
    price: 2,
    appId: 'candy-1',
    quantity: 10,
    vendor: new mongoose.Types.ObjectId(),
    photo: { url: 'u', publicId: 'p' },
  });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('handleQuantityMessage', () => {
  it('applies a delta once and ignores redeliveries of the same event id', async () => {
    expect(await handleQuantityMessage('candy-1', delta(-2), 'evt-1:0')).toBe('applied');
    expect(await handleQuantityMessage('candy-1', delta(-2), 'evt-1:0')).toBe('duplicate');
    expect(await handleQuantityMessage('candy-1', delta(-2), 'evt-1:0')).toBe('duplicate');

    expect(await quantityOf('candy-1')).toBe(8);
    expect(await ProcessedEventModel.countDocuments()).toBe(1);
  });

  it('applies distinct event ids separately', async () => {
    await handleQuantityMessage('candy-1', delta(-2), 'evt-1:0');
    await handleQuantityMessage('candy-1', delta(-3), 'evt-2:0');
    expect(await quantityOf('candy-1')).toBe(5);
  });

  it('applies concurrent deliveries of the same event exactly once', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => handleQuantityMessage('candy-1', delta(-1), 'evt-race:0')));

    expect(results.filter(r => r === 'applied')).toHaveLength(1);
    expect(await quantityOf('candy-1')).toBe(9);
  });

  it('applies events without an id (legacy) without deduplication', async () => {
    await handleQuantityMessage('candy-1', delta(-1));
    await handleQuantityMessage('candy-1', delta(-1));
    expect(await quantityOf('candy-1')).toBe(8);
    expect(await ProcessedEventModel.countDocuments()).toBe(0);
  });

  it('rolls back the event id when the candy is unknown, as a permanent error', async () => {
    const error = await handleQuantityMessage('ghost', delta(-1), 'evt-ghost:0').catch(e => e);

    expect(isPermanentError(error)).toBe(true);
    expect(await ProcessedEventModel.countDocuments({ eventId: 'evt-ghost:0' })).toBe(0);
  });

  it('treats malformed payloads and a missing key as permanent errors', async () => {
    expect(isPermanentError(await handleQuantityMessage('candy-1', '{not json', 'e1').catch(e => e))).toBe(true);
    expect(isPermanentError(await handleQuantityMessage('candy-1', JSON.stringify({ quantity: 'x' }), 'e2').catch(e => e))).toBe(true);
    expect(isPermanentError(await handleQuantityMessage(undefined, delta(1), 'e3').catch(e => e))).toBe(true);
    expect(await quantityOf('candy-1')).toBe(10);
  });
});

describe('handleUserMessage', () => {
  it('rejects a malformed user event as permanent', async () => {
    expect(isPermanentError(await handleUserMessage(JSON.stringify({ appId: 'not-a-uuid' })).catch(e => e))).toBe(true);
  });
});
