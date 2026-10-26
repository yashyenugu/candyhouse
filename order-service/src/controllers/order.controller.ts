import { HttpException } from '@/exceptions/HttpException';
import { RequestWithUser } from '@/interfaces/auth.interface';
import { producer } from '@/lib/kafka';
import CandyModel from '@/models/candy.model';
import OrderModel from '@/models/order.model';
import OutboxModel from '@/models/outbox.model';
import { orderByIdSchema, orderInputSchema, orderUpdateSchema, orderConfirmSchema, paginatedOrderFetchSchema } from '@/utils/schemas/order';
import { Status } from '@/utils/types/order';
import { NextFunction, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import Stripe from 'stripe';

// Temporary best-effort relay: publish right after commit and mark the row sent.
// If Kafka is down the row stays pending, so a proper relay (transactional outbox)
// can pick it up later; until then this is the one remaining weak point.
const publishOutbox = async (outboxId: unknown, messages: { key: string; value: string }[]): Promise<void> => {
  try {
    await producer.connect();
    // A stable event id per message lets consumers drop redeliveries (same outbox row, same index).
    await producer.send({
      topic: 'quantity',
      messages: messages.map((message, index) => ({ ...message, headers: { eventId: `${String(outboxId)}:${index}` } })),
    });
    await OutboxModel.updateOne({ _id: outboxId }, { status: 'sent' });
  } catch (error) {
    console.error('Failed to publish outbox event; left pending', error);
  }
};

export class OrderController {
  public allForAdmin = async (req: RequestWithUser, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { page, limit }: z.infer<typeof paginatedOrderFetchSchema> = req.query;
      let pageNum;
      let limitNum = parseInt(limit);

      if (!page) {
        pageNum = 1;
      } else {
        pageNum = parseInt(page);
      }

      if (!limit) {
        limitNum = 6;
      } else {
        limitNum = parseInt(limit);
      }
      const orders = await OrderModel.find()
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum + 1);

      res.send({
        hasMore: orders.length === limitNum + 1,
        orders: orders.slice(0, limitNum),
      });
    } catch (error) {
      next(error);
    }
  };

  public create = async (req: RequestWithUser, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { items, address }: z.infer<typeof orderInputSchema> = req.body;
      // Calculate total
      let total = 0;
      for (const x of items) {
        total += x.price * x.itemsInCart;
      }
      // Create Stripe PaymentIntent
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, { apiVersion: '2025-07-30.basil' });
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(total * 100), // Stripe expects amount in cents
        currency: 'usd',
        metadata: {
          address,
          userId: req.user._id.toString(),
        },
      });
      res.send({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
      next(error);
    }
  };

  public getOrdersOfUser = async (req: RequestWithUser, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { page, limit }: z.infer<typeof paginatedOrderFetchSchema> = req.query;
      let pageNum;
      let limitNum = parseInt(limit);

      if (!page) {
        pageNum = 1;
      } else {
        pageNum = parseInt(page);
      }

      if (!limit) {
        limitNum = 6;
      } else {
        limitNum = parseInt(limit);
      }

      const orders = await OrderModel.find({ user: req.user._id })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum + 1);

      res.send({
        hasMore: orders.length === limitNum + 1,
        orders: orders.slice(0, limitNum),
      });

      //******************************************* */
    } catch (error) {
      next(error);
    }
  };

  public oneById = async (req: RequestWithUser, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id }: z.infer<typeof orderByIdSchema> = req.params;

      const order = await OrderModel.findOne({ _id: id });

      if (!order) {
        throw new HttpException(404, 'Order not found');
      }

      res.send(order);
    } catch (error) {
      next(error);
    }
  };

  public cancel = async (req: RequestWithUser, res: Response, next: NextFunction): Promise<void> => {
    const session = await mongoose.startSession();
    try {
      const { id }: z.infer<typeof orderByIdSchema> = req.params;
      let outboxId: unknown;
      let restock: { key: string; value: string }[] = [];

      await session.withTransaction(async () => {
        const order = await OrderModel.findOne({ _id: id }).session(session);

        if (!order) {
          throw new HttpException(404, 'order not found');
        }

        if (order.status === Status.Cancelled) {
          throw new HttpException(400, 'Order is already cancelled');
        }

        await OrderModel.findByIdAndUpdate(id, { status: Status.Cancelled }, { session });

        // Restock is a positive delta, recorded in the same transaction as the cancellation.
        restock = order.items.map(orderItem => ({
          key: orderItem.candy,
          value: JSON.stringify({ quantity: orderItem.itemsInCart }),
        }));
        const [outbox] = await OutboxModel.create([{ topic: 'quantity', messages: restock, status: 'pending' }], { session });
        outboxId = outbox._id;
      });

      await publishOutbox(outboxId, restock);

      res.send(await OrderModel.findById(id));
    } catch (error) {
      next(error);
    } finally {
      await session.endSession();
    }
  };

  public update = async (req: RequestWithUser, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { address, bank, items, status }: z.infer<typeof orderUpdateSchema> = req.body;

      const { id } = req.params;

      const order = await OrderModel.findByIdAndUpdate(id, { address, bank, items, status });
      res.send(order);
    } catch (error) {
      next(error);
    }
  };

  public confirmAndCreate = async (req: RequestWithUser, res: Response, next: NextFunction): Promise<void> => {
    const session = await mongoose.startSession();
    try {
      const { paymentIntentId, items, address }: z.infer<typeof orderConfirmSchema> = req.body;

      // Transform items: ensure appId is mapped to candy
      const transformedItems = items.map(item => ({
        ...item,
        candy: item.candy || item.appId, // Use candy if present, otherwise use appId
      }));
      // Verify payment status with Stripe. External calls stay outside the transaction.
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, { apiVersion: '2025-07-30.basil' });
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (paymentIntent.status !== 'succeeded') {
        res.status(400).json({ error: 'Payment not confirmed' });
        return;
      }

      const candyQuantityUpdates = transformedItems.map(orderItem => ({
        key: orderItem.candy,
        value: JSON.stringify({ quantity: -orderItem.itemsInCart }),
      }));

      let order;
      let outboxId: unknown;
      let replayed = false;
      await session.withTransaction(async () => {
        // Idempotency: a payment that already produced an order returns that order.
        const existing = await OrderModel.findOne({ paymentId: paymentIntentId }).session(session);
        if (existing) {
          order = existing;
          replayed = true;
          return;
        }

        const candyIds = [...new Set(transformedItems.map(item => item.candy))];
        const candyDocuments = await CandyModel.find({ appId: { $in: candyIds } }).session(session);
        for (const candyDocument of candyDocuments) {
          const numItems = transformedItems.find(item => item.candy == candyDocument.appId)?.itemsInCart ?? 0;
          if (candyDocument.quantity - numItems < 0) {
            throw new HttpException(400, 'Insufficient stock for candy ' + candyDocument.name);
          }
        }

        // With a session, create() needs an array or the session is ignored.
        const [created] = await OrderModel.create(
          [
            {
              user: req.user._id,
              items: transformedItems,
              price: paymentIntent.amount / 100, // Stripe amount is in cents (dollars now)
              address,
              coinsRedeemed: 0,
              paymentId: paymentIntentId,
            },
          ],
          { session },
        );
        order = created;

        const [outbox] = await OutboxModel.create([{ topic: 'quantity', messages: candyQuantityUpdates, status: 'pending' }], { session });
        outboxId = outbox._id;
      });

      if (!replayed) {
        await publishOutbox(outboxId, candyQuantityUpdates);
      }

      res.send(order);
    } catch (error) {
      // 11000: a concurrent request for the same payment won the race; replay its order.
      if ((error as { code?: number })?.code === 11000) {
        const existing = await OrderModel.findOne({ paymentId: req.body.paymentIntentId });
        if (existing) {
          res.send(existing);
          return;
        }
      }
      next(error);
    } finally {
      await session.endSession();
    }
  };
}
