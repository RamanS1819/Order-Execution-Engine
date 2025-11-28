# Order Execution Engine

A minimal order execution engine using Fastify, PostgreSQL, Redis, BullMQ, and WebSockets.

It accepts swap orders, queues them, processes them in a worker, saves results in Postgres, and streams status updates in real time.

## Features

- **REST API** to submit swap orders
- **BullMQ worker** for asynchronous execution
- **Mock DEX router** for quotes, routing, and transaction simulation
- **1% slippage protection**
- **PostgreSQL table** for order tracking
- **WebSocket status streaming**
- **Jest end-to-end test suite** (15 tests)

## Description

The engine accepts orders via REST, assigns them to a BullMQ queue, processes them in a separate worker, and updates the order’s status in both the database and via WebSocket messages sent to subscribed clients.

## How to Run (Three-Terminal Setup)

### Terminal 1: Start Redis and PostgreSQL

```bash
docker-compose up -d
```

### Terminal 2: Start the Worker
```bash
npx ts-node src/worker.ts
```
### Terminal 3: Run Tests
```bash
npx jest --runInBand
```

### OUTPUT (Example message)
```bash
{ "status": "ROUTING" }
{ "status": "BUILDING_TX", "venue": "Raydium" }
{ "status": "SUBMITTING" }
{ "status": "CONFIRMED", "txHash": "5x..." }
```
## Project Structure

```bash
src/
 ├── db.ts        # Postgres connection and table initialization
 ├── index.ts     # Fastify API, WebSocket server, and queue
 ├── worker.ts    # Background job execution logic
tests/
 └── engine.test.ts
