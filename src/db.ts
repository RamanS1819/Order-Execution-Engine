// src/db.ts
import { Pool } from 'pg';

// Connect to the Docker Postgres container running on localhost
export const pool = new Pool({
  connectionString: 'postgres://user:password@localhost:5432/exchange_db'
});

export const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        input_mint TEXT NOT NULL,
        output_mint TEXT NOT NULL,
        amount BIGINT NOT NULL,
        status TEXT DEFAULT 'PENDING',
        tx_hash TEXT,
        venue TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Database Table Verified");
  } catch (error) {
    console.error("❌ DB Error:", error);
  }
};