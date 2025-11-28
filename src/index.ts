// import Fastify from 'fastify';
// import websocket from '@fastify/websocket';
// import cors from '@fastify/cors';
// import { Queue } from 'bullmq';
// import Redis from 'ioredis';
// import { initDb, pool } from './db';

// const app = Fastify({ logger: true });

// // FIX: Added maxRetriesPerRequest: null here as well
// const REDIS_CONNECTION = { 
//   host: 'localhost', 
//   port: 6379,
//   maxRetriesPerRequest: null 
// };

// const orderQueue = new Queue('order-queue', { connection: new Redis(REDIS_CONNECTION) });

// app.register(cors);
// app.register(websocket);

// initDb();

// app.register(async (fastify) => {
//   fastify.get('/ws/status', { websocket: true }, (connection, req) => {
//     const query = req.query as { orderId?: string };
    
//     if (!query.orderId) {
//       connection.close();
//       return;
//     }
//     console.log(`Client connected tracking order: ${query.orderId}`);

//     const sub = new Redis(REDIS_CONNECTION);
//     sub.subscribe(`updates:${query.orderId}`);
    
//     sub.on('message', (channel, message) => {
//       connection.send(message); 
//     });

//     connection.on('close', () => sub.disconnect());
//   });
// });

// app.post('/api/orders/execute', async (req, reply) => {
//   const { inputMint, outputMint, amount } = req.body as any;

//   if (!inputMint ||!amount) return reply.code(400).send({ error: "Invalid Input" });

//   try {
//     const result = await pool.query(
//       `INSERT INTO orders (input_mint, output_mint, amount) VALUES ($1, $2, $3) RETURNING id`,
//       [inputMint, outputMint, amount]
//     );

//     const orderId = result.rows[0].id;

//     await orderQueue.add('swap', { orderId, inputMint, amount });

//     return { orderId, status: 'PENDING', message: 'Order Queued' };

//   } catch (err) {
//     console.error(err);
//     return reply.code(500).send({ error: "Internal Server Error" });
//   }
// });

// // app.listen({ port: 3000 }, (err, address) => {
// //   if (err) {
// //     console.error(err);
// //     process.exit(1);
// //   }
// //   console.log(`🚀 Server running at ${address}`);
// // });

// // Export app for testing
// export { app };

// // Only start server if run directly (not when imported by tests)
// if (require.main === module) {
//   app.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
//     if (err) {
//       console.error(err);
//       process.exit(1);
//     }
//     console.log(`🚀 Server running at ${address}`);
//   });
// }

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { initDb, pool } from './db';

const app = Fastify({ logger: true });

const REDIS_CONNECTION = { 
  host: 'localhost', 
  port: 6379,
  maxRetriesPerRequest: null 
};

// Initialize Queue
const orderQueue = new Queue('order-queue', { connection: new Redis(REDIS_CONNECTION) });

app.register(cors);
app.register(websocket);

// Initialize DB on startup
initDb();

// WebSocket Endpoint for Status Updates
// app.register(async (fastify) => {
//   fastify.get('/ws/status', { websocket: true }, (connection, req) => {
//     const query = req.query as { orderId?: string };
    
//     if (!query.orderId) {
//       connection.close();
//       return;
//     }
//     // console.log(`Client connected tracking order: ${query.orderId}`);

//     const sub = new Redis(REDIS_CONNECTION);
//     sub.subscribe(`updates:${query.orderId}`);
    
//     sub.on('message', (channel, message) => {
//       connection.send(message); 
//     });

//     connection.on('close', () => sub.disconnect());
//   });
// });
app.register(async (fastify) => {
  fastify.get('/ws/status', { websocket: true }, (connection, req) => {
    const query = req.query as { orderId?: string };

    if (!query.orderId) {
      // Close immediately if no orderId provided
      connection.close();
      return;
    }

    // create a dedicated Redis subscriber for this websocket
        const sub = new Redis(REDIS_CONNECTION);
    
        // Defensive: handle Redis errors so they don't crash tests
        sub.on('error', (err) => {
          // log for debugging and close the WS connection cleanly
          console.error(`[WS:${query.orderId}] Redis error:`, (err as any)?.message ?? err);
          try { connection.close(); } catch (e) {}
          try { sub.disconnect(); } catch (e) {}
        });

    // If redis connection closes unexpectedly, close ws to avoid hanging tests
    sub.on('end', () => {
      // end is triggered when connection closed
      try { connection.close(); } catch (e) {}
    });

    // Subscribe (async) and guard with try/catch
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

    // Forward incoming redis messages to websocket client
    sub.on('message', (channel, message) => {
      // defend against broken JSON or a closed connection
      try {
        if (connection.readyState === 1) {
          connection.send(message);
        }
      } catch (err) {
        console.error(`[WS:${query.orderId}] Failed to send message over websocket:`, (err as any)?.message ?? err);
      }
    });

    // When client disconnects, cleanup redis subscription/connection
    connection.on('close', () => {
      try { sub.unsubscribe(`updates:${query.orderId}`); } catch (e) {}
      try { sub.disconnect(); } catch (e) {}
    });
  });
});


// // API Endpoint to Execute Order
// --- Strongly validated endpoint for order execution ---
const executeOrderSchema = {
  body: {
    type: 'object',
    required: ['inputMint', 'outputMint', 'amount'],
    properties: {
      inputMint: { type: 'string' },
      outputMint: { type: 'string' },
      amount: { type: 'number' }
    },
    additionalProperties: false
  }
};

app.post('/api/orders/execute', async (req, reply) => {
  const { inputMint, outputMint, amount } = req.body as any;

  // Defensive checks (guarantee we return 400 instead of blowing up)
  if (typeof inputMint !== 'string' || typeof outputMint !== 'string') {
    return reply.code(400).send({ error: 'inputMint and outputMint must be strings' });
  }
  if (typeof amount !== 'number') {
    return reply.code(400).send({ error: 'amount must be a number' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO orders (input_mint, output_mint, amount) VALUES ($1, $2, $3) RETURNING id`,
      [inputMint, outputMint, amount]
    );
    const orderId = result.rows[0].id;
    await orderQueue.add('swap', { orderId, inputMint, amount }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 }});
    return { orderId, status: 'PENDING', message: 'Order Queued' };
  } catch (err) {
    console.error('handler error:', err);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
});


// app.post(
//   '/api/orders/execute',
//   { schema: executeOrderSchema },   // <-- THIS enforces validation
//   async (req, reply) => {
//     const { inputMint, outputMint, amount } = req.body as {
//       inputMint: string;
//       outputMint: string;
//       amount: number;
//     };

//     try {
//       const result = await pool.query(
//         `INSERT INTO orders (input_mint, output_mint, amount) VALUES ($1, $2, $3) RETURNING id`,
//         [inputMint, outputMint, amount]
//       );

//       const orderId = result.rows[0].id;

//       await orderQueue.add('swap',
//         { orderId, inputMint, amount },
//         { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }
//       );

//       return { orderId, status: 'PENDING', message: 'Order Queued' };
//     } catch (err) {
//       console.error(err);
//       return reply.code(500).send({ error: 'Internal Server Error' });
//     }
//   }
// );

// // --- Strongly validated endpoint for order execution ---
// const executeOrderSchema = {
//   body: {
//     type: 'object',
//     required: ['inputMint', 'outputMint', 'amount'],
//     properties: {
//       inputMint: { type: 'string' },
//       outputMint: { type: 'string' },
//       amount: { type: 'number' }
//     },
//     additionalProperties: false
//   }
// };

// app.post(
//   '/api/orders/execute',
//   { schema: executeOrderSchema },   // <-- THIS enforces validation
//   async (req, reply) => {
//     const { inputMint, outputMint, amount } = req.body as {
//       inputMint: string;
//       outputMint: string;
//       amount: number;
//     };

//     try {
//       const result = await pool.query(
//         `INSERT INTO orders (input_mint, output_mint, amount) VALUES ($1, $2, $3) RETURNING id`,
//         [inputMint, outputMint, amount]
//       );

//       const orderId = result.rows[0].id;

//       await orderQueue.add('swap',
//         { orderId, inputMint, amount },
//         { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }
//       );

//       return { orderId, status: 'PENDING', message: 'Order Queued' };
//     } catch (err) {
//       console.error(err);
//       return reply.code(500).send({ error: 'Internal Server Error' });
//     }
//   }
// );



// Export for Testing
export { app };

// Start Server if run directly
if (require.main === module) {
  app.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`🚀 Server running at ${address}`);
  });
}