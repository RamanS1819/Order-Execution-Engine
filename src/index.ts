import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { initDb, pool } from './db';

// Create Fastify instance with logging enabled
const app = Fastify({ logger: true });

// Redis connection settings
const REDIS_CONNECTION = { 
  host: 'localhost', 
  port: 6379,
  maxRetriesPerRequest: null // required for BullMQ
};

// Job queue for order execution tasks
const orderQueue = new Queue('order-queue', { connection: new Redis(REDIS_CONNECTION) });

// Register middlewares
app.register(cors);
app.register(websocket);

// Create DB table if missing
initDb();

// --- WebSocket endpoint for real-time order updates ---
app.register(async (fastify) => {
  fastify.get('/ws/status', { websocket: true }, (connection, req) => {
    const query = req.query as { orderId?: string };

    // Reject connections without orderId
    if (!query.orderId) {
      connection.close();
      return;
    }

    // Create dedicated Redis subscriber
    const sub = new Redis(REDIS_CONNECTION);

    // Prevent Redis errors from crashing the test/server
    sub.on('error', (err) => {
      console.error(`[WS:${query.orderId}] Redis error:`, (err as any)?.message ?? err);
      try { connection.close(); } catch (e) {}
      try { sub.disconnect(); } catch (e) {}
    });

    // If Redis disconnects → close WebSocket too
    sub.on('end', () => {
      try { connection.close(); } catch (e) {}
    });

    // Async subscribe with safety try/catch
    (async () => {
      try {
        await sub.subscribe(`updates:${query.orderId}`);
      } catch (err) {
        console.error(`[WS:${query.orderId}] Failed to subscribe:`, (err as any)?.message ?? err);
        try { connection.close(); } catch (e) {}
        try { sub.disconnect(); } catch (e) {}
        return;
      }
    })();

    // Forward any Redis update to WebSocket client
    sub.on('message', (channel, message) => {
      try {
        if (connection.readyState === 1) {
          connection.send(message);
        }
      } catch (err) {
        console.error(`[WS:${query.orderId}] WS send error:`, (err as any)?.message ?? err);
      }
    });

    // Cleanup Redis on WS close
    connection.on('close', () => {
      try { sub.unsubscribe(`updates:${query.orderId}`); } catch (e) {}
      try { sub.disconnect(); } catch (e) {}
    });
  });
});


// --- API: Submit new order for execution ---
const executeOrderSchema = {
  body: {
    type: 'object',
    required: ['inputMint', 'outputMint', 'amount'],
    properties: {
      inputMint: { type: 'string' },
      outputMint: { type: 'string' },
      amount: { type: 'number' }
    },
    additionalProperties: false // no extra fields allowed
  }
};

app.post('/api/orders/execute', async (req, reply) => {
  const { inputMint, outputMint, amount } = req.body as any;

  // Basic type validation to avoid 500 errors
  if (typeof inputMint !== 'string' || typeof outputMint !== 'string') {
    return reply.code(400).send({ error: 'inputMint and outputMint must be strings' });
  }
  if (typeof amount !== 'number') {
    return reply.code(400).send({ error: 'amount must be a number' });
  }

  try {
    // Insert order as PENDING
    const result = await pool.query(
      `INSERT INTO orders (input_mint, output_mint, amount) VALUES ($1, $2, $3) RETURNING id`,
      [inputMint, outputMint, amount]
    );

    const orderId = result.rows[0].id;

    // Add job to worker with 3 retries & exponential backoff
    await orderQueue.add(
      'swap', 
      { orderId, inputMint, amount }, 
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 }}
    );

    // Respond to client
    return { orderId, status: 'PENDING', message: 'Order Queued' };

  } catch (err) {
    console.error('handler error:', err);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
});


// Export app for Jest testing
export { app };

// Start server only when file is run directly (not during Jest)
if (require.main === module) {
  app.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`🚀 Server running at ${address}`);
  });
}
