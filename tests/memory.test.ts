import { describe, expect, test } from "bun:test";
import { JSONRewriter } from "./index";

const CACHE_DIR = ".benchdata";
const PACKAGE_NAME = "wrangler";
const CHUNK_SIZE = 32 * 1024;
const PACKAGE_REGISTRY_ORIGIN = "https://registry.npmjs.org/";

interface MemoryCase {
  name: string;
  createRewriter: () => JSONRewriter;
}

interface MemoryPeaks {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

interface MemoryResult {
  name: string;
  durationMs: number;
  throughputMiBps: number;
  outputBytes: number;
  peakRssDelta: number;
  peakHeapUsedDelta: number;
  peakExternalDelta: number;
  peakArrayBuffersDelta: number;
  retainedRssDelta: number;
}

describe("large document memory profile", () => {
  test(
    "reports peak memory while streaming the wrangler npm packument",
    async () => {
      const input = await loadPackument(PACKAGE_NAME);
      const cases: MemoryCase[] = [
        {
          name: "pass-through",
          createRewriter: () => new JSONRewriter(),
        },
        {
          name: "remove integrity fields",
          createRewriter: () =>
            new JSONRewriter().on("$..integrity", {
              value(node) {
                node.remove();
              },
            }),
        },
        {
          name: "rewrite tarball urls",
          createRewriter: () =>
            new JSONRewriter().on("$..tarball", {
              string(node) {
                node.replace(node.value.replace(PACKAGE_REGISTRY_ORIGIN, "https://cache.example.com/npm/"));
              },
            }),
        },
        {
          name: "remove versions subtree",
          createRewriter: () =>
            new JSONRewriter().on("$.versions", {
              object(node) {
                node.remove();
              },
            }),
        },
        {
          name: "combined mutations",
          createRewriter: () =>
            new JSONRewriter()
              .on("$..integrity", {
                value(node) {
                  node.remove();
                },
              })
              .on("$..tarball", {
                string(node) {
                  node.replace(node.value.replace(PACKAGE_REGISTRY_ORIGIN, "https://cache.example.com/npm/"));
                },
              })
              .on('$["dist-tags"]', {
                object(node) {
                  node.prepend("benchmarked", true).append("source", "json-rewriter");
                },
              })
              .on('$["dist-tags"].*', {
                string(node) {
                  node.replace(`v${node.value}`);
                },
              }),
        },
      ];

      const maxRssDeltaBytes = readOptionalMiBEnv("MEMORY_MAX_RSS_DELTA_MB");
      const results: MemoryResult[] = [];

      for (const memoryCase of cases) {
        const result = await profileCase(input, memoryCase);
        results.push(result);

        expect(result.outputBytes).toBeGreaterThan(0);
        if (memoryCase.name === "remove versions subtree") {
          expect(result.outputBytes).toBeLessThan(input.byteLength);
        }
        if (maxRssDeltaBytes !== undefined) {
          expect(result.peakRssDelta).toBeLessThanOrEqual(maxRssDeltaBytes);
        }
      }

      console.table(
        results.map((result) => ({
          case: result.name,
          duration: `${result.durationMs.toFixed(2)}ms`,
          throughput: `${result.throughputMiBps.toFixed(1)} MiB/s`,
          output: formatBytes(result.outputBytes),
          "peak rss +": formatBytes(result.peakRssDelta),
          "peak heap +": formatBytes(result.peakHeapUsedDelta),
          "peak external +": formatBytes(result.peakExternalDelta),
          "peak buffers +": formatBytes(result.peakArrayBuffersDelta),
          "retained rss +": formatBytes(result.retainedRssDelta),
        })),
      );
    },
    120_000,
  );
});

async function profileCase(input: Uint8Array, memoryCase: MemoryCase): Promise<MemoryResult> {
  Bun.gc(true);

  const baseline = readMemoryPeaks();
  const peaks: MemoryPeaks = { ...baseline };
  const sample = () => updatePeaks(peaks);
  sample();

  const response = memoryCase.createRewriter().transform(responseFromBytes(input, sample));
  const startedAt = performance.now();
  const outputBytes = await drainBytes(response, sample);
  const durationMs = performance.now() - startedAt;
  sample();

  Bun.gc(true);
  const afterGc = readMemoryPeaks();

  return {
    name: memoryCase.name,
    durationMs,
    throughputMiBps: input.byteLength / 1024 / 1024 / (durationMs / 1000),
    outputBytes,
    peakRssDelta: positiveDelta(peaks.rss, baseline.rss),
    peakHeapUsedDelta: positiveDelta(peaks.heapUsed, baseline.heapUsed),
    peakExternalDelta: positiveDelta(peaks.external, baseline.external),
    peakArrayBuffersDelta: positiveDelta(peaks.arrayBuffers, baseline.arrayBuffers),
    retainedRssDelta: positiveDelta(afterGc.rss, baseline.rss),
  };
}

function responseFromBytes(input: Uint8Array, sample: () => void): Response {
  let offset = 0;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        sample();
        if (offset >= input.byteLength) {
          controller.close();
          return;
        }

        const end = Math.min(offset + CHUNK_SIZE, input.byteLength);
        controller.enqueue(input.subarray(offset, end));
        offset = end;
        sample();
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function drainBytes(response: Response, sample: () => void): Promise<number> {
  if (!response.body) {
    throw new TypeError("Cannot profile a Response without a body");
  }

  const reader = response.body.getReader();
  let bytes = 0;

  try {
    while (true) {
      sample();
      const { done, value } = await reader.read();
      sample();
      if (done) {
        return bytes;
      }
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

async function loadPackument(packageName: string): Promise<Uint8Array> {
  await ensureCacheDir();
  const cachePath = `${CACHE_DIR}/${packageName.replaceAll("/", "__")}.json`;
  const cached = Bun.file(cachePath);

  if (await cached.exists()) {
    return new Uint8Array(await cached.arrayBuffer());
  }

  const response = await fetch(`https://registry.npmjs.org/${packageName}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${packageName} packument: ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(cachePath, bytes);
  return bytes;
}

async function ensureCacheDir(): Promise<void> {
  const directory = Bun.file(CACHE_DIR);
  if (!(await directory.exists())) {
    await Bun.$`mkdir -p ${CACHE_DIR}`.quiet();
  }
}

function readMemoryPeaks(): MemoryPeaks {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function updatePeaks(peaks: MemoryPeaks): void {
  const current = readMemoryPeaks();
  peaks.rss = Math.max(peaks.rss, current.rss);
  peaks.heapTotal = Math.max(peaks.heapTotal, current.heapTotal);
  peaks.heapUsed = Math.max(peaks.heapUsed, current.heapUsed);
  peaks.external = Math.max(peaks.external, current.external);
  peaks.arrayBuffers = Math.max(peaks.arrayBuffers, current.arrayBuffers);
}

function positiveDelta(value: number, baseline: number): number {
  return Math.max(0, value - baseline);
}

function readOptionalMiBEnv(name: string): number | undefined {
  const raw = Bun.env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number of MiB`);
  }
  return value * 1024 * 1024;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} KiB`;
  }
  return `${value} B`;
}
