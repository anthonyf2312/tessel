import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    // Sandbox tests spawn real child processes; give them room.
    testTimeout: 20_000,
  },
});
