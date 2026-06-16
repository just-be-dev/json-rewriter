import { describe, expect, test } from "bun:test";
import { JSONRewriter } from "./index";

// CI guard against performance and memory regressions.
//
// Absolute timing/memory numbers are not portable across machines (a GitHub
// runner is several times slower than a dev laptop), so we never assert on raw
// values. Instead we assert on machine-independent ratios:
//
//   performance: each mutation case's throughput is normalised against the
//     pass-through rewrite measured in the same iteration. Pass-through runs the
//     full tokenizer + serializer with no mutation work, so it tracks CPU speed
//     and cancels out of the ratio.
//
//   memory: peak external memory is normalised against the document size. A
//     streaming rewriter keeps this bounded (~1x, the live input); a regression
//     that buffers the whole output would push it toward 2x.
//
// Each metric is sampled over many iterations and reduced with the median, which
// shrugs off the occasional CI scheduling spike. Baselines live in
// regression/baselines.json; regenerate them with UPDATE_BASELINES=1.

const CACHE_DIR = ".benchdata";
const BASELINES_PATH = "regression/baselines.json";
const PACKAGE_NAME = "wrangler";
const CHUNK_SIZE = 64 * 1024;
const PACKAGE_REGISTRY_ORIGIN = "https://registry.npmjs.org/";

const PASS_THROUGH = "pass-through";

const ITERATIONS = readPositiveIntEnv("REGRESSION_ITERATIONS", 7);
const WARMUP = readIntEnv("REGRESSION_WARMUP", 2, 0);
// Tolerances are intentionally generous: the goal is catching real regressions
// (something got meaningfully slower or started buffering), not chasing noise.
const PERF_TOLERANCE = readRatioEnv("REGRESSION_PERF_TOLERANCE", 0.35);
const MEMORY_TOLERANCE = readRatioEnv("REGRESSION_MEMORY_TOLERANCE", 0.5);
// Streaming-drop cases (e.g. removing a whole subtree) peak at a few hundred KiB
// of fixed-size internal buffers that do not scale with the document and vary by
// platform, so a relative tolerance on that tiny ratio is pure noise. The real
// regression for those cases is buffering the dropped subtree, which pushes the
// ratio toward 1.0. This minimum ceiling absorbs the small-scale noise while
// still catching a jump toward whole-document buffering.
const MEMORY_MIN_CEILING = readRatioEnv("REGRESSION_MEMORY_MIN_CEILING", 0.25);
const UPDATE_BASELINES = Bun.env.UPDATE_BASELINES === "1";

interface Scenario {
  name: string;
  createRewriter: () => JSONRewriter;
}

interface Baselines {
  document: string;
  documentBytes: number;
  // mutation case -> throughput as a fraction of the pass-through rewrite
  performance: Record<string, number>;
  // mutation case -> peak external memory as a fraction of the document size
  memory: Record<string, number>;
}

interface MemorySample {
  peakExternal: number;
  peakRss: number;
  peakHeapUsed: number;
}

interface CaseStats {
  name: string;
  throughputSamples: number[]; // MiB/s per iteration
  memorySamples: MemorySample[];
}

const SCENARIOS: Scenario[] = [
  {
    name: PASS_THROUGH,
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

const regressionTest = Bun.env.REGRESSION === "1" ? test : test.skip;

describe("performance and memory regression", () => {
  regressionTest(
    `stays within tolerance of committed baselines (${ITERATIONS} iterations)`,
    async () => {
      const input = await loadPackument(PACKAGE_NAME);
      const docBytes = input.byteLength;

      const stats = await measure(input);
      const passThrough = byName(stats, PASS_THROUGH);

      // Performance: per-iteration ratio of each mutation case to the
      // pass-through rewrite, reduced with the median.
      const perfRatios = new Map<string, number>();
      for (const stat of stats) {
        if (stat.name === PASS_THROUGH) continue;
        const perItem = stat.throughputSamples.map(
          (value, index) => value / (passThrough.throughputSamples[index] ?? value),
        );
        perfRatios.set(stat.name, median(perItem));
      }

      // Memory: peak external memory as a fraction of the document size.
      // Recorded for every case but only gated for the mutation cases.
      const memRatios = new Map<string, number>();
      for (const stat of stats) {
        memRatios.set(stat.name, median(stat.memorySamples.map((sample) => sample.peakExternal / docBytes)));
      }

      reportTable(stats, perfRatios, memRatios);

      if (UPDATE_BASELINES) {
        const next: Baselines = {
          document: PACKAGE_NAME,
          documentBytes: docBytes,
          performance: roundMap(perfRatios),
          memory: roundMap(memRatios, PASS_THROUGH),
        };
        await Bun.write(BASELINES_PATH, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Wrote ${BASELINES_PATH}. Re-run without UPDATE_BASELINES=1 to verify.`);
        return;
      }

      const baselines = await loadBaselines();

      for (const [name, actual] of perfRatios) {
        const baseline = baselines.performance[name];
        expect(baseline, `missing perf baseline for "${name}" — run UPDATE_BASELINES=1`).toBeDefined();

        const floor = (baseline as number) * (1 - PERF_TOLERANCE);
        expect(
          actual,
          `"${name}" throughput ratio ${actual.toFixed(3)} regressed below ${floor.toFixed(3)} ` +
            `(baseline ${(baseline as number).toFixed(3)}, tolerance ${(PERF_TOLERANCE * 100).toFixed(0)}%)`,
        ).toBeGreaterThanOrEqual(floor);
      }

      // Pass-through memory is deliberately not gated: it is a reference point,
      // not a cost we ship, and its peak is dominated by runtime/GC noise.
      for (const [name, actual] of memRatios) {
        if (name === PASS_THROUGH) continue;
        const baseline = baselines.memory[name];
        expect(baseline, `missing memory baseline for "${name}" — run UPDATE_BASELINES=1`).toBeDefined();

        const ceiling = Math.max((baseline as number) * (1 + MEMORY_TOLERANCE), MEMORY_MIN_CEILING);
        expect(
          actual,
          `"${name}" peak external/doc ratio ${actual.toFixed(3)} regressed above ${ceiling.toFixed(3)} ` +
            `(baseline ${(baseline as number).toFixed(3)}, tolerance ${(MEMORY_TOLERANCE * 100).toFixed(0)}%)`,
        ).toBeLessThanOrEqual(ceiling);
      }
    },
    300_000,
  );
});

async function measure(input: Uint8Array): Promise<CaseStats[]> {
  const stats: CaseStats[] = SCENARIOS.map((scenario) => ({
    name: scenario.name,
    throughputSamples: [],
    memorySamples: [],
  }));

  // Throughput pass first (no memory sampling, so timing is clean), then a
  // separate memory pass (sampling adds overhead that would skew timing).
  for (let i = 0; i < WARMUP + ITERATIONS; i += 1) {
    for (let s = 0; s < SCENARIOS.length; s += 1) {
      const scenario = SCENARIOS[s]!;
      const stat = stats[s]!;
      Bun.gc(true);
      const startedAt = performance.now();
      const output = await scenario.createRewriter().transform(responseFromBytes(input)).arrayBuffer();
      const durationMs = performance.now() - startedAt;
      expect(output.byteLength).toBeGreaterThan(0);
      if (i >= WARMUP) {
        stat.throughputSamples.push(input.byteLength / 1024 / 1024 / (durationMs / 1000));
      }
    }
  }

  for (let i = 0; i < WARMUP + ITERATIONS; i += 1) {
    for (let s = 0; s < SCENARIOS.length; s += 1) {
      const scenario = SCENARIOS[s]!;
      const stat = stats[s]!;
      const sample = await profileMemory(input, scenario);
      if (i >= WARMUP) {
        stat.memorySamples.push(sample);
      }
    }
  }

  return stats;
}

async function profileMemory(input: Uint8Array, scenario: Scenario): Promise<MemorySample> {
  Bun.gc(true);
  const baseline = process.memoryUsage();
  let peakExternal = 0;
  let peakRss = 0;
  let peakHeapUsed = 0;

  const sample = () => {
    const usage = process.memoryUsage();
    peakExternal = Math.max(peakExternal, usage.external - baseline.external);
    peakRss = Math.max(peakRss, usage.rss - baseline.rss);
    peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed - baseline.heapUsed);
  };

  const response = scenario.createRewriter().transform(responseFromBytes(input, sample));
  const reader = response.body!.getReader();
  try {
    while (true) {
      sample();
      const { done } = await reader.read();
      sample();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  return {
    peakExternal: Math.max(0, peakExternal),
    peakRss: Math.max(0, peakRss),
    peakHeapUsed: Math.max(0, peakHeapUsed),
  };
}

function responseFromBytes(input: Uint8Array, onPull?: () => void): Response {
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        onPull?.();
        if (offset >= input.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + CHUNK_SIZE, input.byteLength);
        controller.enqueue(input.subarray(offset, end));
        offset = end;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function reportTable(stats: CaseStats[], perfRatios: Map<string, number>, memRatios: Map<string, number>): void {
  console.table(
    stats.map((stat) => ({
      case: stat.name,
      "throughput (med)": `${median(stat.throughputSamples).toFixed(1)} MiB/s`,
      "perf ratio": stat.name === PASS_THROUGH ? "ref" : (perfRatios.get(stat.name) ?? 0).toFixed(3),
      "peak external": formatBytes(median(stat.memorySamples.map((sample) => sample.peakExternal))),
      "ext/doc ratio":
        stat.name === PASS_THROUGH
          ? `${(memRatios.get(stat.name) ?? 0).toFixed(3)} (ungated)`
          : (memRatios.get(stat.name) ?? 0).toFixed(3),
    })),
  );
}

function byName(stats: CaseStats[], name: string): CaseStats {
  const stat = stats.find((candidate) => candidate.name === name);
  if (!stat) throw new Error(`No measurements for scenario "${name}"`);
  return stat;
}

async function loadBaselines(): Promise<Baselines> {
  const file = Bun.file(BASELINES_PATH);
  if (!(await file.exists())) {
    throw new Error(`Missing ${BASELINES_PATH}. Generate it with: UPDATE_BASELINES=1 REGRESSION=1 mise run regression`);
  }
  return (await file.json()) as Baselines;
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function roundMap(values: Map<string, number>, exclude?: string): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [key, value] of values) {
    if (key === exclude) continue;
    next[key] = Math.round(value * 1000) / 1000;
  }
  return next;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  return readIntEnv(name, fallback, 1);
}

function readIntEnv(name: string, fallback: number, minimum: number): number {
  const raw = Bun.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function readRatioEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
  return `${value.toFixed(0)} B`;
}
