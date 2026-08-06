import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'core',
      root: './packages/core',
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'adapters',
      root: './packages/adapters',
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'ebay',
      root: './packages/ebay',
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  },
]);
