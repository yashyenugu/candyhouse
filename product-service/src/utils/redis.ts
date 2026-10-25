import Redis, { RedisOptions } from 'ioredis';

// Environment-aware Redis configuration.
// ioredis supports Redis Sentinel natively (node-redis v4 does not), which is
// why the Sentinel config below now actually takes effect in production.
const isProduction = process.env.NODE_ENV === 'production';
const useSentinel = process.env.REDIS_USE_SENTINEL === 'true' || isProduction;

const options: RedisOptions = useSentinel
  ? {
      // Production: discover the master through Sentinel for automatic failover.
      sentinels: [
        {
          host: process.env.REDIS_SENTINEL_1 || 'candyhouse-redis-sentinel-0.candyhouse-redis-headless',
          port: parseInt(process.env.REDIS_SENTINEL_PORT || '26379'),
        },
        {
          host: process.env.REDIS_SENTINEL_2 || 'candyhouse-redis-sentinel-1.candyhouse-redis-headless',
          port: parseInt(process.env.REDIS_SENTINEL_PORT || '26379'),
        },
      ],
      name: process.env.REDIS_MASTER_NAME || 'mymaster',
      password: process.env.REDIS_PASSWORD,
    }
  : {
      // Development: direct Redis connection.
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || 'dev-redis-password',
    };

// ioredis connects automatically on creation (and reconnects on failover).
const redisClient = new Redis(options);

redisClient.on('error', err => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('Redis Client Connected'));
redisClient.on('reconnecting', () => console.log('Redis Client Reconnecting'));

export const connectRedis = async () => {
  try {
    await redisClient.config('SET', 'maxmemory-policy', 'allkeys-lru');
    const connectionType = useSentinel ? 'Redis Sentinel' : 'Redis Direct';
    console.log(`✅ Connected to ${connectionType}`);
    console.log('📊 Configured Redis eviction policy to allkeys-lru');
  } catch (error) {
    console.error('❌ Error connecting to Redis:', error);
    throw error;
  }
};

export const getCache = async (key: string) => {
  try {
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.error('Error getting cache:', error);
    return null;
  }
};

export const setCache = async (key: string, value: unknown, ttl?: number) => {
  try {
    const stringValue = JSON.stringify(value);
    if (ttl) {
      await redisClient.setex(key, ttl, stringValue);
    } else {
      await redisClient.set(key, stringValue);
    }
    return true;
  } catch (error) {
    console.error('Error setting cache:', error);
    return false;
  }
};

export const deleteCache = async (key: string) => {
  try {
    await redisClient.del(key);
    return true;
  } catch (error) {
    console.error('Error deleting cache:', error);
    return false;
  }
};

export const incrementCacheCounter = async (key: string, ttl?: number): Promise<number> => {
  try {
    const newCount = await redisClient.incr(key);
    if (ttl) {
      await redisClient.expire(key, ttl);
    }
    return newCount;
  } catch (error) {
    console.error('Error incrementing cache counter:', error);
    return 0;
  }
};
