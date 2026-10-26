const redisMock = {
  on: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  config: jest.fn(),
};
const RedisCtor = jest.fn((..._args: unknown[]) => redisMock);

jest.mock('ioredis', () => ({ __esModule: true, default: RedisCtor }));

describe('redis util', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...env };
  });

  afterAll(() => {
    process.env = env;
  });

  it('connects directly outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.REDIS_USE_SENTINEL;
    require('@/utils/redis');
    const opts = RedisCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.sentinels).toBeUndefined();
    expect(opts.host).toBe('localhost');
  });

  it('uses Sentinel in production', () => {
    process.env.NODE_ENV = 'production';
    require('@/utils/redis');
    const opts = RedisCtor.mock.calls[0][0] as { sentinels: unknown[]; name: string };
    expect(opts.sentinels).toHaveLength(2);
    expect(opts.name).toBe('mymaster');
  });

  it('lets REDIS_USE_SENTINEL=false override production', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_USE_SENTINEL = 'false';
    require('@/utils/redis');
    const opts = RedisCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.sentinels).toBeUndefined();
  });

  it('getCache parses JSON and returns null on miss', async () => {
    const { getCache } = require('@/utils/redis');
    redisMock.get.mockResolvedValueOnce('{"a":1}').mockResolvedValueOnce(null);
    expect(await getCache('k')).toEqual({ a: 1 });
    expect(await getCache('k')).toBeNull();
  });

  it('setCache uses setex with a ttl and set without', async () => {
    const { setCache } = require('@/utils/redis');
    await setCache('k', { a: 1 }, 60);
    expect(redisMock.setex).toHaveBeenCalledWith('k', 60, '{"a":1}');
    await setCache('k', { a: 1 });
    expect(redisMock.set).toHaveBeenCalledWith('k', '{"a":1}');
  });

  it('incrementCacheCounter increments and sets expiry', async () => {
    const { incrementCacheCounter } = require('@/utils/redis');
    redisMock.incr.mockResolvedValueOnce(3);
    expect(await incrementCacheCounter('c', 100)).toBe(3);
    expect(redisMock.expire).toHaveBeenCalledWith('c', 100);
  });

  it('connectRedis sets the eviction policy', async () => {
    const { connectRedis } = require('@/utils/redis');
    redisMock.config.mockResolvedValueOnce('OK');
    await connectRedis();
    expect(redisMock.config).toHaveBeenCalledWith('SET', 'maxmemory-policy', 'allkeys-lru');
  });
});
