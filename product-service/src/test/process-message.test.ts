import { PermanentError } from '@/consumers/message-handlers';
import { IncomingMessage, processWithDlq } from '@/consumers/process-message';

const message: IncomingMessage = {
  topic: 'quantity',
  partition: 0,
  offset: '42',
  key: 'candy-1',
  value: '{"quantity":-1}',
  headers: { eventId: 'evt-1:0' },
};

const noSleep = jest.fn().mockResolvedValue(undefined);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('processWithDlq', () => {
  it('does not touch the DLQ when the handler succeeds', async () => {
    const sendToDlq = jest.fn();
    await processWithDlq(message, async () => 'ok', { sendToDlq, sleep: noSleep });
    expect(sendToDlq).not.toHaveBeenCalled();
  });

  it('retries a transient failure with backoff and then succeeds', async () => {
    const sendToDlq = jest.fn();
    const handler = jest.fn().mockRejectedValueOnce(new Error('mongo blip')).mockRejectedValueOnce(new Error('mongo blip')).mockResolvedValue('ok');

    await processWithDlq(message, handler, { sendToDlq, sleep: noSleep, retryDelaysMs: [100, 200, 400] });

    expect(handler).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
    expect(sendToDlq).not.toHaveBeenCalled();
  });

  it('backs off exponentially (within jitter)', async () => {
    const delays: number[] = [];
    const handler = jest.fn().mockRejectedValue(new Error('down'));
    await processWithDlq(message, handler, {
      sendToDlq: jest.fn(),
      sleep: async ms => void delays.push(ms),
      retryDelaysMs: [100, 1000, 10000],
    });

    expect(delays).toHaveLength(3);
    [100, 1000, 10000].forEach((base, i) => {
      expect(delays[i]).toBeGreaterThanOrEqual(base * 0.5);
      expect(delays[i]).toBeLessThanOrEqual(base);
    });
  });

  it('sends to <topic>.dlq with error context after retries are exhausted', async () => {
    const sendToDlq = jest.fn().mockResolvedValue(undefined);
    const handler = jest.fn().mockRejectedValue(new Error('always down'));

    await processWithDlq(message, handler, { sendToDlq, sleep: noSleep, retryDelaysMs: [1, 1] });

    expect(handler).toHaveBeenCalledTimes(3);
    expect(sendToDlq).toHaveBeenCalledTimes(1);
    expect(sendToDlq).toHaveBeenCalledWith({
      topic: 'quantity.dlq',
      key: 'candy-1',
      value: '{"quantity":-1}',
      headers: {
        eventId: 'evt-1:0',
        'x-error': 'always down',
        'x-attempts': '3',
        'x-original-topic': 'quantity',
        'x-original-partition': '0',
        'x-original-offset': '42',
      },
    });
  });

  it('sends a permanent error to the DLQ immediately without retrying', async () => {
    const sendToDlq = jest.fn().mockResolvedValue(undefined);
    const handler = jest.fn().mockRejectedValue(new PermanentError('unknown candy'));

    await processWithDlq(message, handler, { sendToDlq, sleep: noSleep });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
    expect(sendToDlq).toHaveBeenCalledTimes(1);
  });

  it('throws when the DLQ publish fails, so the message is redelivered and not lost', async () => {
    const sendToDlq = jest.fn().mockRejectedValue(new Error('kafka down'));
    const handler = jest.fn().mockRejectedValue(new PermanentError('bad'));

    await expect(processWithDlq(message, handler, { sendToDlq, sleep: noSleep })).rejects.toThrow('kafka down');
  });
});
