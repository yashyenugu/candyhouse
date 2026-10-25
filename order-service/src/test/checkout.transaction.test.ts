import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { NextFunction, Response } from 'express';
import { RequestWithUser } from '@/interfaces/auth.interface';
import OrderModel from '@/models/order.model';
import OutboxModel from '@/models/outbox.model';
import CandyModel from '@/models/candy.model';
import { OrderController } from '@/controllers/order.controller';
import { Status } from '@/utils/types/order';

const mockRetrieve = jest.fn();
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ paymentIntents: { retrieve: mockRetrieve } })));
const mockSend = jest.fn();
jest.mock('@/lib/kafka', () => ({
  producer: { connect: jest.fn(), send: (...args: unknown[]) => mockSend(...args) },
}));

let replset: MongoMemoryReplSet;
const controller = new OrderController();
const userId = new mongoose.Types.ObjectId();

const item = (candy: string, itemsInCart: number) => ({
  candy,
  name: candy,
  price: 2,
  quantity: 10,
  description: 'd',
  itemsInCart,
  photo: { url: 'u', publicId: 'p' },
});

const run = async (handler: (req: RequestWithUser, res: Response, next: NextFunction) => Promise<void>, req: object) => {
  const res = { send: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await handler(req as RequestWithUser, res as unknown as Response, next);
  return { res, next };
};

const seedCandy = (appId: string, quantity: number) =>
  CandyModel.create({
    name: appId,
    description: 'd',
    price: 2,
    appId,
    quantity,
    vendor: new mongoose.Types.ObjectId(),
    photo: { url: 'u', publicId: 'p' },
  });

const checkoutReq = (candy: string, itemsInCart: number) => ({
  user: { _id: userId },
  body: { paymentIntentId: 'pi_1', address: 'addr', items: [item(candy, itemsInCart)] },
});

beforeAll(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri());
  await Promise.all([OrderModel.init(), OutboxModel.init(), CandyModel.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replset.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockRetrieve.mockResolvedValue({ status: 'succeeded', amount: 400 });
  await Promise.all([OrderModel.deleteMany({}), OutboxModel.deleteMany({}), CandyModel.deleteMany({})]);
});

describe('transactions', () => {
  it('rolls back writes when the transaction throws', async () => {
    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => {
        await OrderModel.create([{ user: userId, items: [], address: 'x', price: 1, coinsRedeemed: 0 }], { session });
        await OutboxModel.create([{ topic: 'quantity', messages: [] }], { session });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await session.endSession();

    expect(await OrderModel.countDocuments()).toBe(0);
    expect(await OutboxModel.countDocuments()).toBe(0);
  });
});

describe('confirmAndCreate', () => {
  it('creates one order and one outbox row, then publishes and marks it sent', async () => {
    await seedCandy('c1', 5);
    const { res, next } = await run(controller.confirmAndCreate, checkoutReq('c1', 2));

    expect(next).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(await OrderModel.countDocuments()).toBe(1);
    const outbox = await OutboxModel.find();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].messages).toEqual([{ key: 'c1', value: JSON.stringify({ quantity: -2 }) }]);
    expect(outbox[0].status).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('leaves the outbox row pending when Kafka fails, but keeps the order', async () => {
    await seedCandy('c1', 5);
    mockSend.mockRejectedValueOnce(new Error('kafka down'));
    const { res, next } = await run(controller.confirmAndCreate, checkoutReq('c1', 1));

    expect(next).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalled();
    expect(await OrderModel.countDocuments()).toBe(1);
    expect((await OutboxModel.findOne())?.status).toBe('pending');
  });

  it('writes nothing when stock is insufficient', async () => {
    await seedCandy('c1', 1);
    const { res, next } = await run(controller.confirmAndCreate, checkoutReq('c1', 3));

    expect(res.send).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(await OrderModel.countDocuments()).toBe(0);
    expect(await OutboxModel.countDocuments()).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects unconfirmed payments without touching the database', async () => {
    mockRetrieve.mockResolvedValue({ status: 'requires_payment_method', amount: 400 });
    const { res } = await run(controller.confirmAndCreate, checkoutReq('c1', 1));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(await OrderModel.countDocuments()).toBe(0);
  });
});

describe('cancel', () => {
  it('cancels and records a positive restock delta', async () => {
    const order = await OrderModel.create({ user: userId, items: [item('c1', 2)], address: 'a', price: 4, coinsRedeemed: 0 });
    const { next } = await run(controller.cancel, { params: { id: order._id.toString() } });

    expect(next).not.toHaveBeenCalled();
    expect((await OrderModel.findById(order._id))?.status).toBe(Status.Cancelled);
    const outbox = await OutboxModel.findOne();
    expect(outbox?.messages).toEqual([{ key: 'c1', value: JSON.stringify({ quantity: 2 }) }]);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('refuses to cancel twice and adds no second outbox row', async () => {
    const order = await OrderModel.create({
      user: userId,
      items: [item('c1', 2)],
      address: 'a',
      price: 4,
      coinsRedeemed: 0,
      status: Status.Cancelled,
    });
    const { next } = await run(controller.cancel, { params: { id: order._id.toString() } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(await OutboxModel.countDocuments()).toBe(0);
  });
});
