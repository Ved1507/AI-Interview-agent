/**
 * Jest Setup File
 * Configure test environment and global test utilities
 */

// Set environment to test
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Suppress logs during tests

// Increase timeout for database tests
jest.setTimeout(10000);

// Global test utilities
global.testUtils = {
  // Add common test utilities here
};

export {};
