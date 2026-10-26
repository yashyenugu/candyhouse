import { isPermanentError } from './message-handlers';

export interface IncomingMessage {
  topic: string;
  partition: number;
  offset: string;
  key?: string;
  value: string;
  headers: Record<string, string>;
}

export interface DlqMessage {
  topic: string;
  key?: string;
  value: string;
  headers: Record<string, string>;
}

export interface ProcessDeps {
  sendToDlq: (message: DlqMessage) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
}

export const DEFAULT_RETRY_DELAYS_MS = [200, 1000, 5000];

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Full jitter keeps instances from retrying in lockstep.
const withJitter = (ms: number) => Math.round(ms * (0.5 + Math.random() / 2));

export const dlqTopicFor = (topic: string) => `${topic}.dlq`;

// Runs the handler with bounded retries and exponential backoff. A permanent error, or running out of
// retries, sends the message to `<topic>.dlq` with the error attached and then returns, so the
// consumer moves on instead of blocking or silently dropping it. If the DLQ publish itself fails this
// throws, so the message is redelivered rather than lost.
export const processWithDlq = async (message: IncomingMessage, handler: () => Promise<unknown>, deps: ProcessDeps): Promise<void> => {
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    try {
      await handler();
      return;
    } catch (error) {
      const retriable = !isPermanentError(error) && attempt <= delays.length;
      if (retriable) {
        await sleep(withJitter(delays[attempt - 1]));
        continue;
      }

      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[DLQ] ${message.topic}[${message.partition}]@${message.offset} after ${attempt} attempt(s): ${reason}`);
      await deps.sendToDlq({
        topic: dlqTopicFor(message.topic),
        key: message.key,
        value: message.value,
        headers: {
          ...message.headers,
          'x-error': reason.slice(0, 500),
          'x-attempts': String(attempt),
          'x-original-topic': message.topic,
          'x-original-partition': String(message.partition),
          'x-original-offset': message.offset,
        },
      });
      return;
    }
  }
};
