import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { initDb, pool } from './db';

const app = Fastify({ logger: true });

// FIX: Added maxRetriesPerRequest: null here as well
const REDIS_CONNECTION = { 
  host: 'localhost', 
  port: 6379,
  maxRetriesPerRequest: null 
};

const orderQueue = new Queue('order-queue', { connection: new Redis(REDIS_CONNECTION) });

app.register(cors);
app.register(websocket);

initDb();

app.register(async (fastify) => {
  fastify.get('/ws/status', { websocket: true }, (connection, req) => {
    const query = req.query as { orderId?: string };
    
    if (!query.orderId) {
      connection.close();
      return;
    }
    console.log(`Client connected tracking order: ${query.orderId}`);

    const sub = new Redis(REDIS_CONNECTION);
    sub.subscribe(`updates:${query.orderId}`);
    
    sub.on('message', (channel, message) => {
      connection.send(message); 
    });

    connection.on('close', () => sub.disconnect());
  });
});

app.post('/api/orders/execute', async (req, reply) => {
  const { inputMint, outputMint, amount } = req.body as any;

  if (!inputMint ||!amount) return reply.code(400).send({ error: "Invalid Input" });

  try {
    const result = await pool.query(
      `INSERT INTO orders (input_mint, output_mint, amount) VALUES ($1, $2, $3) RETURNING id`,
      [inputMint, outputMint, amount]
    );

    const orderId = result.rows[0].id;

    await orderQueue.add('swap', { orderId, inputMint, amount });

    return { orderId, status: 'PENDING', message: 'Order Queued' };

  } catch (err) {
    console.error(err);
    return reply.code(500).send({ error: "Internal Server Error" });
  }
});

app.listen({ port: 3000 }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running at ${address}`);
});