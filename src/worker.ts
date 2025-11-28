import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { pool } from './db';

// FIX: BullMQ requires 'maxRetriesPerRequest: null'
const REDIS_CONNECTION = {
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null 
};

const redisPublisher = new Redis(REDIS_CONNECTION);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function sendUpdate(orderId: string, status: string, data: any = {}) {
  await redisPublisher.publish(`updates:${orderId}`, JSON.stringify({ status,...data }));
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
  console.log(`[Order ${orderId}] -> ${status}`);
}

const worker = new Worker('order-queue', async (job) => {
  const { orderId } = job.data;
  console.log(`Processing Order: ${orderId}`);

  try {
    // 1. ROUTING
    await sendUpdate(orderId, 'ROUTING');
    await sleep(1000); 
    
    const venue = Math.random() > 0.5? 'Raydium' : 'Meteora';
    console.log(`Best price found on: ${venue}`);

    // 2. BUILDING
    await sendUpdate(orderId, 'BUILDING_TX', { venue });
    await sleep(1000);

    // 3. SUBMITTING
    await sendUpdate(orderId, 'SUBMITTING');
    await sleep(2000); 

    // 4. CONFIRMED
    const txHash = '5x' + Math.random().toString(36).substring(7); 
    await sendUpdate(orderId, 'CONFIRMED', { txHash, venue });
    
    await pool.query('UPDATE orders SET tx_hash = $1, venue = $2 WHERE id = $3', 
      [txHash, venue, orderId]
    );

  } catch (e) {
    console.error(e);
    await sendUpdate(orderId, 'FAILED', { error: 'Transaction failed' });
  }
}, { 
  connection: new Redis(REDIS_CONNECTION) 
});

console.log("👷 Worker is listening for jobs...");