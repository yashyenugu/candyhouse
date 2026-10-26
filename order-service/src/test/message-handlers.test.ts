import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import CandyModel from '@/models/candy.model';
import PendingCandyModel from '@/models/pending-candy.model';
import { UserModel } from '@/models/user.model';
import { handleCandyMessage, handleUserMessage } from '@/consumers/message-handlers';

let mongod: MongoMemoryServer;

const VENDOR_APP_ID = '11111111-1111-4111-8111-111111111111';

const userEvent = (overrides = {}) =>
  JSON.stringify({ _id: 'x', appId: VENDOR_APP_ID, email: 'v@test.dev', name: 'vendor', role: 'vendor', ...overrides });

const candyEvent = (overrides = {}) =>
  JSON.stringify({
    name: 'gummy',
    description: 'd',
    price: 2,
    quantity: 5,
    photo: { url: 'u', publicId: 'p' },
    appId: 'candy-1',
    vendor: VENDOR_APP_ID,
    ...overrides,
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([UserModel.init(), CandyModel.init(), PendingCandyModel.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([UserModel.deleteMany({}), CandyModel.deleteMany({}), PendingCandyModel.deleteMany({})]);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('candy event arriving before its vendor user event', () => {
  it('parks the candy, then stores it when the vendor arrives', async () => {
    // Before the fix the vendor lookup failed once and the candy was silently lost.
    expect(await handleCandyMessage(candyEvent())).toBe(false);
    expect(await CandyModel.countDocuments()).toBe(0);
    expect(await PendingCandyModel.countDocuments({ appId: 'candy-1' })).toBe(1);

    await handleUserMessage(userEvent());

    const candy = await CandyModel.findOne({ appId: 'candy-1' });
    const vendor = await UserModel.findOne({ appId: VENDOR_APP_ID });
    expect(candy).not.toBeNull();
    expect(String(candy?.vendor)).toBe(String(vendor?._id));
    expect(await PendingCandyModel.countDocuments()).toBe(0);
  });

  it('keeps only the latest event for a parked candy', async () => {
    await handleCandyMessage(candyEvent({ quantity: 1 }));
    await handleCandyMessage(candyEvent({ quantity: 7 }));
    expect(await PendingCandyModel.countDocuments()).toBe(1);

    await handleUserMessage(userEvent());
    expect((await CandyModel.findOne({ appId: 'candy-1' }))?.quantity).toBe(7);
  });

  it('applies every candy parked for a vendor and leaves other vendors parked', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    await handleCandyMessage(candyEvent({ appId: 'candy-1' }));
    await handleCandyMessage(candyEvent({ appId: 'candy-2', name: 'second' }));
    await handleCandyMessage(candyEvent({ appId: 'candy-3', name: 'third', vendor: other }));

    await handleUserMessage(userEvent());

    expect(await CandyModel.countDocuments()).toBe(2);
    expect(await PendingCandyModel.find().then(p => p.map(x => x.appId))).toEqual(['candy-3']);
  });
});

describe('handleCandyMessage', () => {
  it('creates the candy, then updates it on a later event', async () => {
    await handleUserMessage(userEvent());
    expect(await handleCandyMessage(candyEvent())).toBe(true);
    expect(await handleCandyMessage(candyEvent({ quantity: 9 }))).toBe(true);

    const candies = await CandyModel.find({ appId: 'candy-1' });
    expect(candies).toHaveLength(1);
    expect(candies[0].quantity).toBe(9);
  });

  it('rejects a malformed event', async () => {
    await expect(handleCandyMessage(JSON.stringify({ name: 'x' }))).rejects.toThrow();
  });
});

describe('handleUserMessage', () => {
  it('creates the user and updates it on a later event', async () => {
    await handleUserMessage(userEvent());
    await handleUserMessage(userEvent({ name: 'renamed' }));

    const users = await UserModel.find({ appId: VENDOR_APP_ID });
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe('renamed');
  });
});
