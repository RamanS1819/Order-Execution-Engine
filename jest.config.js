// module.exports = {
//   preset: 'ts-jest',
//   testEnvironment: 'node',
//   testTimeout: 30000, // Give the worker time to process
// };
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ["**/**/*.test.ts"], // Looks for .test.ts files
  verbose: true,
  forceExit: true, // Forces Jest to exit after tests (useful for Fastify/DB connections)
  // connection handling for supertest + fastify
};