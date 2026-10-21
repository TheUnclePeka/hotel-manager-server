import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Pure import/parser tests do not connect. An accidental connection must fail.
    env: { DATABASE_URL: 'postgres://unit_test@127.0.0.1:1/unit_test' },
  },
});
