// import { Worker } from 'bullmq';
// import Redis from 'ioredis';
// import { pool } from './db';

// // FIX: BullMQ requires 'maxRetriesPerRequest: null'
// const REDIS_CONNECTION = {
//   host: 'localhost',
//   port: 6379,
//   maxRetriesPerRequest: null 
// };

// const redisPublisher = new Redis(REDIS_CONNECTION);

// const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// async function sendUpdate(orderId: string, status: string, data: any = {}) {
//   await redisPublisher.publish(`updates:${orderId}`, JSON.stringify({ status,...data }));
//   await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
//   console.log(`[Order ${orderId}] -> ${status}`);
// }

// const worker = new Worker('order-queue', async (job) => {
//   const { orderId } = job.data;
//   console.log(`Processing Order: ${orderId}`);

//   try {
//     // 1. ROUTING
//     await sendUpdate(orderId, 'ROUTING');
//     await sleep(1000); 
    
//     const venue = Math.random() > 0.5? 'Raydium' : 'Meteora';
//     console.log(`Best price found on: ${venue}`);

//     // 2. BUILDING
//     await sendUpdate(orderId, 'BUILDING_TX', { venue });
//     await sleep(1000);

//     // 3. SUBMITTING
//     await sendUpdate(orderId, 'SUBMITTING');
//     await sleep(2000); 

//     // 4. CONFIRMED
//     const txHash = '5x' + Math.random().toString(36).substring(7); 
//     await sendUpdate(orderId, 'CONFIRMED', { txHash, venue });
    
//     await pool.query('UPDATE orders SET tx_hash = $1, venue = $2 WHERE id = $3', 
//       [txHash, venue, orderId]
//     );

//   } catch (e) {
//     console.error(e);
//     await sendUpdate(orderId, 'FAILED', { error: 'Transaction failed' });
//   }
// }, { 
//   connection: new Redis(REDIS_CONNECTION) 
// });

// console.log("👷 Worker is listening for jobs...");

import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { pool } from './db';

const REDIS_CONNECTION = {
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null
};

const redisPublisher = new Redis(REDIS_CONNECTION);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- MOCK DEX ROUTER CLASS (Required by PDF) ---
class MockDexRouter {
  // Simulate fetching a quote with network delay and price variance
  async getQuote(venue: string, amount: number): Promise<number> {
    await sleep(200 + Math.random() * 200); // 200-400ms delay
    
    // Base price simulation (e.g., 1 SOL = 150 USDC)
    const baseRate = 150; 
    
    // Add small variance (-1% to +1%) to make prices different
    const variance = (Math.random() * 0.02) - 0.01; 
    const price = baseRate * (1 + variance);
    
    return amount * price;
  }

  async executeSwap(venue: string, amount: number) {
    await sleep(1000); // Simulate transaction time on Solana
    // Generate a mock signature looking like a Solana tx
    return '5x' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
  }
}

const router = new MockDexRouter();

// Helper to publish updates to Redis + Update DB
async function sendUpdate(orderId: string, status: string, data: any = {}) {
  await redisPublisher.publish(`updates:${orderId}`, JSON.stringify({ status, ...data }));
  
  // Only update DB status if it's a major state change
  if (['CONFIRMED', 'FAILED'].includes(status)) {
    // Final updates handled in main flow
  } else {
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
  }
  
  console.log(`[Order ${orderId}] -> ${status}`);
}

const worker = new Worker('order-queue', async (job) => {
  const { orderId, amount } = job.data;
  console.log(`Processing Order: ${orderId}`);

  try {
    // 1. ROUTING
    await sendUpdate(orderId, 'ROUTING');
    
    // Fetch quotes in parallel (Concurrent Processing)
    const [raydiumQuote, meteoraQuote] = await Promise.all([
      router.getQuote('Raydium', amount),
      router.getQuote('Meteora', amount)
    ]);

    console.log(` Quotes: Raydium: ${raydiumQuote.toFixed(2)} | Meteora: ${meteoraQuote.toFixed(2)}`);

    // Select Best Venue
    const bestVenue = raydiumQuote > meteoraQuote ? 'Raydium' : 'Meteora';
    
    // 2. BUILDING TRANSACTION
    await sendUpdate(orderId, 'BUILDING_TX', { venue: bestVenue });
    await sleep(500); 

    // 3. SUBMITTING
    await sendUpdate(orderId, 'SUBMITTING');
    
    // 4. EXECUTING (Wait for confirmation)
    const txHash = await router.executeSwap(bestVenue, amount);

    // 5. CONFIRMED
    await sendUpdate(orderId, 'CONFIRMED', { txHash, venue: bestVenue });
    
    // Final DB Update
    await pool.query(
      'UPDATE orders SET status = $1, tx_hash = $2, venue = $3 WHERE id = $4', 
      ['CONFIRMED', txHash, bestVenue, orderId]
    );

  } catch (e) {
    console.error(e);
    await sendUpdate(orderId, 'FAILED', { error: 'Transaction failed' });
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['FAILED', orderId]);
    throw e; // Throwing triggers BullMQ retry logic
  }
}, { 
  connection: new Redis(REDIS_CONNECTION) 
});

console.log("👷 Smart Worker is listening for jobs...");