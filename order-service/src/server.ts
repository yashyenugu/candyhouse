import { App } from '@/app';
import { ValidateEnv } from '@utils/validateEnv';
import { OrderRoute } from './routes/order.route';
import { connectDB } from './lib/mongoose';
import { MONGO_URI } from './config';
import { consumer } from './lib/kafka';
import { handleCandyMessage, handleUserMessage } from './consumers/message-handlers';
import { BankRoute } from './routes/bank.route';

const start = async () => {
  ValidateEnv();
  await connectDB(MONGO_URI);

  await consumer.connect();
  await consumer.subscribe({ topics: ['user', 'candy'] });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      try {
        if (topic === 'candy') {
          await handleCandyMessage(message.value.toString());
        } else if (topic === 'user') {
          await handleUserMessage(message.value.toString());
        }
      } catch (err) {
        console.log(err);
      }
    },
  });

  const app = new App([new OrderRoute(), new BankRoute()]);

  app.listen();
};

start();
