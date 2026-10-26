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
const mockCreateIntent = jest.fn();
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ paymentIntents: { retrieve: mockRetrieve, create: mockCreateIntent } })));
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

const checkoutReq = (candy: string, itemsInCart: number, paymentIntentId = 'pi_1') => ({
  user: { _id: userId },
  body: { paymentIntentId, address: 'addr', items: [item(candy, itemsInCart)] },
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
  mockCreateIntent.mockResolvedValue({ client_secret: 'cs_test' });
  await Promise.all([OrderModel.deleteMany({}), OutboxModel.deleteMany({}), CandyModel.deleteMany({})]);
});

describe('transactions', () => {
  it('rolls back writes when the transaction throws', async () => {
    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => {
        await OrderModel.create([{ user: userId, items: [], address: 'x', price: 1, coinsRedeemed: 0, paymentId: 'pi_x' }], { session });
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

describe('idempotent checkout', () => {
  it('returns the same order when confirm is retried sequentially', async () => {
    await seedCandy('c1', 10);
    const first = await run(controller.confirmAndCreate, checkoutReq('c1', 1));
    const second = await run(controller.confirmAndCreate, checkoutReq('c1', 1));

    expect(second.next).not.toHaveBeenCalled();
    expect(second.res.send.mock.calls[0][0]._id).toEqual(first.res.send.mock.calls[0][0]._id);
    expect(await OrderModel.countDocuments({ paymentId: 'pi_1' })).toBe(1);
    expect(await OutboxModel.countDocuments()).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('creates one order for concurrent confirms of the same payment', async () => {
    await seedCandy('c1', 10);
    const results = await Promise.all([1, 2, 3].map(() => run(controller.confirmAndCreate, checkoutReq('c1', 1))));

    const ids = results.map(r => String(r.res.send.mock.calls[0][0]._id));
    expect(results.every(r => r.next.mock.calls.length === 0)).toBe(true);
    expect(new Set(ids).size).toBe(1);
    expect(await OrderModel.countDocuments({ paymentId: 'pi_1' })).toBe(1);
    expect(await OutboxModel.countDocuments()).toBe(1);
  });

  it('keeps distinct payments as distinct orders', async () => {
    await seedCandy('c1', 10);
    await run(controller.confirmAndCreate, checkoutReq('c1', 1, 'pi_a'));
    await run(controller.confirmAndCreate, checkoutReq('c1', 1, 'pi_b'));

    expect(await OrderModel.countDocuments()).toBe(2);
    expect(await OutboxModel.countDocuments()).toBe(2);
  });

  it('has a unique index on paymentId', async () => {
    const indexes = await OrderModel.collection.indexes();
    expect(indexes.some(i => i.key.paymentId === 1 && i.unique)).toBe(true);
  });
});

describe('cancel', () => {
  it('cancels and records a positive restock delta', async () => {
    const order = await OrderModel.create({ user: userId, items: [item('c1', 2)], address: 'a', price: 4, coinsRedeemed: 0, paymentId: 'pi_c' });
    const { next } = await run(controller.cancel, { user: { _id: userId }, params: { id: order._id.toString() } });

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
      paymentId: 'pi_c',
      status: Status.Cancelled,
    });
    const { next } = await run(controller.cancel, { user: { _id: userId }, params: { id: order._id.toString() } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(await OutboxModel.countDocuments()).toBe(0);
  });
});

describe('stock', () => {
  const localQuantity = async (appId: string) => (await CandyModel.findOne({ appId }))?.quantity;
  const owner = { _id: userId, role: 'user' };

  it("decrements this service's copy on checkout and restores it on cancel", async () => {
    await seedCandy('c1', 5);
    const { res } = await run(controller.confirmAndCreate, { ...checkoutReq('c1', 2), user: owner });
    expect(await localQuantity('c1')).toBe(3);

    const orderId = res.send.mock.calls[0][0]._id;
    await run(controller.cancel, { user: owner, params: { id: String(orderId) } });
    expect(await localQuantity('c1')).toBe(5);
  });

  it('refuses a second purchase that exceeds what is left, without creating an order', async () => {
    await seedCandy('c1', 3);
    await run(controller.confirmAndCreate, checkoutReq('c1', 2, 'pi_a'));
    const second = await run(controller.confirmAndCreate, checkoutReq('c1', 2, 'pi_b'));

    expect(second.next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(await OrderModel.countDocuments()).toBe(1);
    expect(await localQuantity('c1')).toBe(1);
  });

  it('never oversells when concurrent checkouts compete for the last items', async () => {
    await seedCandy('c1', 3);
    const results = await Promise.all(['pi_1', 'pi_2', 'pi_3'].map(pi => run(controller.confirmAndCreate, checkoutReq('c1', 2, pi))));

    expect(results.filter(r => r.res.send.mock.calls.length > 0)).toHaveLength(1);
    expect(await OrderModel.countDocuments()).toBe(1);
    expect(await localQuantity('c1')).toBe(1);
  });

  it('rejects creating a payment for more than the available stock, before Stripe is called', async () => {
    await seedCandy('c1', 3);
    const { next, res } = await run(controller.create, { user: owner, body: { address: 'a', items: [item('c1', 4)] } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(res.send).not.toHaveBeenCalled();
    expect(mockCreateIntent).not.toHaveBeenCalled();
  });

  it('rejects creating a payment for a candy that does not exist', async () => {
    const { next } = await run(controller.create, { user: owner, body: { address: 'a', items: [item('ghost', 1)] } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(mockCreateIntent).not.toHaveBeenCalled();
  });

  it('creates the payment when stock is sufficient', async () => {
    await seedCandy('c1', 3);
    const { res } = await run(controller.create, { user: owner, body: { address: 'a', items: [item('c1', 3)] } });
    expect(res.send).toHaveBeenCalledWith({ clientSecret: 'cs_test' });
  });
});

describe('order ownership', () => {
  const otherUser = { _id: new mongoose.Types.ObjectId(), role: 'user' };
  const owner = { _id: userId, role: 'user' };
  const admin = { _id: new mongoose.Types.ObjectId(), role: 'admin' };

  const makeOrder = (status = Status.Pending) =>
    OrderModel.create({ user: userId, items: [item('c1', 2)], address: 'a', price: 4, coinsRedeemed: 0, paymentId: `pi_${status}`, status });

  it('lets the owner and an admin read an order but hides it from other customers', async () => {
    const order = await makeOrder();
    const params = { id: order._id.toString() };

    expect((await run(controller.oneById, { user: owner, params })).res.send).toHaveBeenCalled();
    expect((await run(controller.oneById, { user: admin, params })).res.send).toHaveBeenCalled();

    const other = await run(controller.oneById, { user: otherUser, params });
    expect(other.res.send).not.toHaveBeenCalled();
    expect(other.next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it("does not let another customer cancel someone else's order", async () => {
    const order = await makeOrder();
    const { next } = await run(controller.cancel, { user: otherUser, params: { id: order._id.toString() } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect((await OrderModel.findById(order._id))?.status).toBe(Status.Pending);
    expect(await OutboxModel.countDocuments()).toBe(0);
  });

  it('refuses to cancel an order that is already delivered', async () => {
    const order = await makeOrder(Status.Delivered);
    const { next } = await run(controller.cancel, { user: owner, params: { id: order._id.toString() } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect((await OrderModel.findById(order._id))?.status).toBe(Status.Delivered);
    expect(await OutboxModel.countDocuments()).toBe(0);
  });
});
