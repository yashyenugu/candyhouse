import { App } from '@/app';
import { ValidateEnv } from '@utils/validateEnv';
import { connectDB } from './lib/mongoose';
import { MONGO_URI } from './config';
import { CandyRoute } from './routes/candy.route';
import { consumer, producer } from './lib/kafka';
import { handleQuantityMessage, handleUserMessage } from './consumers/message-handlers';
import { DlqMessage, processWithDlq } from './consumers/process-message';
import { ImageRoutes as ImageRoute } from './routes/image.route';

const start = async () => {
  ValidateEnv();
  await connectDB(MONGO_URI);

  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({ topics: ['user', 'quantity'] });

  const sendToDlq = async ({ topic, key, value, headers }: DlqMessage) => {
    await producer.send({ topic, messages: [{ key, value, headers }] });
  };

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      if (!message.value) return;

      const headers: Record<string, string> = {};
      for (const [name, header] of Object.entries(message.headers ?? {})) {
        if (header !== undefined) headers[name] = header.toString();
      }
      const incoming = {
        topic,
        partition,
        offset: message.offset,
        key: message.key?.toString(),
        value: message.value.toString(),
        headers,
      };

      const handler =
        topic === 'quantity'
          ? () => handleQuantityMessage(incoming.key, incoming.value, headers.eventId)
          : topic === 'user'
          ? () => handleUserMessage(incoming.value)
          : undefined;
      if (!handler) return;

      await processWithDlq(incoming, handler, { sendToDlq });
    },
  });

  const app = new App([new CandyRoute(), new ImageRoute()]);

  app.listen();
};

start();
