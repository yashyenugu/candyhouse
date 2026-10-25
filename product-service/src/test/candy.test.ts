import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { App } from '@/app';
import { CandyRoute } from '@/routes/candy.route';
import { connectDB } from '@/lib/mongoose';
import CandyModel from '@/models/candy.model';
import mongoose from 'mongoose';

// The controller imports Redis and Kafka clients that connect on import; keep tests off the network.
jest.mock('@/utils/redis', () => ({
  getCache: jest.fn().mockResolvedValue(null),
  setCache: jest.fn().mockResolvedValue(true),
  incrementCacheCounter: jest.fn().mockResolvedValue(1),
}));
jest.mock('@/lib/kafka', () => ({
  producer: { send: jest.fn() },
  consumer: {},
}));

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
});

afterAll(async () => {
  await CandyModel.deleteMany({});
  await mongoose.disconnect();
  await mongod.stop();
});

describe('TEST Candy API', () => {
  const route = new CandyRoute();
  const app = new App([route]);

  describe('[GET] /candy', () => {
    it('responds 200 with an empty page', async () => {
      const res = await request(app.getServer()).get('/candy').query({ page: 1, limit: 6 }).expect(200);
      expect(res.body).toEqual({ hasMore: false, candies: [] });
    });
  });
});
