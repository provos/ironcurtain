import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    // Run test files serially. Several suites load the real ONNX embedding /
    // reranker models; with parallel files and a cold cache they race to
    // populate the on-disk model cache, and a half-written model_quantized.onnx
    // fails to load (seen in the release workflow as 26 ingest.test.ts errors).
    // Serial execution lets the first model-using file warm the cache for the
    // rest. This suite runs in the release workflow, so the slowdown is fine.
    fileParallelism: false,
  },
});
