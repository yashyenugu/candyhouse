// Tests must not depend on a developer's .env file.
process.env.NODE_ENV = 'test';
process.env.LOG_DIR = process.env.LOG_DIR || '../../logs';
process.env.LOG_FORMAT = process.env.LOG_FORMAT || 'dev';
process.env.ORIGIN = process.env.ORIGIN || '*';
