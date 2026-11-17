import { defineConfig } from 'vitest/config'
import baseConfig from '../config/vitest.config'

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    projects: undefined,
    include: ['qa-bench/q2-ingestion-bench.test.ts'],
    benchmark: { include: [] },
    fileParallelism: false,
    retry: 0,
    coverage: { enabled: false }
  }
})
