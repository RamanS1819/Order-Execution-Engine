import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { pool } from './db';

// Redis setup for worker + pub/sub
const REDIS_CONNECTION = {
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null
};

const redisPublisher = new Redis(REDIS_CONNECTION);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Simple mock router to simulate DEX price fetching + swap execution
class MockDexRouter {
  // Fake quote with a small delay + tiny price variation
  async getQuote(venue: string, amount: number): Promise<number> {
    await sleep(200 + Math.random() * 200);
    
    const baseRate = 150; // pretend 1 SOL ~ $150
    const variance = (Math.random() * 0.02) - 0.01; // ±1%
    const price = baseRate * (1 + variance);
    
    return amount * price;
  }

  // Fake transaction execution
  async executeSwap(venue: string, amount: number) {
    await sleep(1000); // pretend network delay
    return '5x' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
  }
}

const router = new MockDexRouter();

// Push status changes to Redis + optionally update DB
async function sendUpdate(orderId: string, status: string, data: any = {}) {
  await redisPublisher.publish(`updates:${orderId}`, JSON.stringify({ status, ...data }));
  
  // Only update mid-states here; final states are saved after swap
  if (!['CONFIRMED', 'FAILED'].includes(status)) {
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
  }

  console.log(`[Order ${orderId}] -> ${status}`);
}

// Worker that processes queued swap jobs
const worker = new Worker('order-queue', async (job) => {
  const { orderId, amount } = job.data;
  console.log(`Processing Order: ${orderId}`);

  try {
    // 1 - Find best venue
    await sendUpdate(orderId, 'ROUTING');

    const [raydiumQuote, meteoraQuote] = await Promise.all([
      router.getQuote('Raydium', amount),
      router.getQuote('Meteora', amount)
    ]);

    console.log(` Quotes: Raydium: ${raydiumQuote.toFixed(2)} | Meteora: ${meteoraQuote.toFixed(2)}`);

    const bestVenue = raydiumQuote > meteoraQuote ? 'Raydium' : 'Meteora';

    // 2 - Pretend to build the transaction
    await sendUpdate(orderId, 'BUILDING_TX', { venue: bestVenue });
    await sleep(500);

    // 3 - Pretend to send it
    await sendUpdate(orderId, 'SUBMITTING');

    // 4 - Simulate confirmation + return mock hash
    const txHash = await router.executeSwap(bestVenue, amount);

    // 5 - Finalize order
    await sendUpdate(orderId, 'CONFIRMED', { txHash, venue: bestVenue });

    await pool.query(
      'UPDATE orders SET status = $1, tx_hash = $2, venue = $3 WHERE id = $4',
      ['CONFIRMED', txHash, bestVenue, orderId]
    );

  } catch (e) {
    console.error(e);

    // Mark as failed and save it
    await sendUpdate(orderId, 'FAILED', { error: 'Transaction failed' });
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['FAILED', orderId]);

    throw e; // let BullMQ retry if needed
  }
}, { 
  connection: new Redis(REDIS_CONNECTION)
});

console.log("👷 Smart Worker is listening for jobs...");
