import { JSONRewriter } from "../index";

const PACKAGES = ["wrangler"];
const CACHE_DIR = ".benchdata";
const DEFAULT_ITERATIONS = 10;
const DEFAULT_WARMUP_ITERATIONS = 3;
const CHUNK_SIZE = 64 * 1024;
const PACKAGE_REGISTRY_ORIGIN = "https://registry.npmjs.org/";

type ScenarioName =
  | "baseline response.arrayBuffer()"
  | "pass-through rewrite"
  | "remove recursive integrity fields"
  | "rewrite tarball urls"
  | "remove versions subtree"
  | "rewrite dist-tags"
  | "combined packument mutations";

interface DocumentFixture {
  name: string;
  bytes: Uint8Array;
}

interface BenchmarkCase {
  name: ScenarioName;
  createRewriter: () => JSONRewriter;
}

interface Sample {
  durationMs: number;
  outputBytes: number;
}

const iterations = readPositiveIntegerFlag("--iterations", DEFAULT_ITERATIONS);
const warmupIterations = readIntegerFlag("--warmup", DEFAULT_WARMUP_ITERATIONS, 0);
const chunkSize = readPositiveIntegerFlag("--chunk-size", CHUNK_SIZE);

await ensureCacheDir();

const fixtures = await Promise.all(PACKAGES.map(loadPackument));
const cases: BenchmarkCase[] = [
  {
    name: "baseline response.arrayBuffer()",
    createRewriter: () => new JSONRewriter(),
  },
  {
    name: "pass-through rewrite",
    createRewriter: () => new JSONRewriter(),
  },
  {
    name: "remove recursive integrity fields",
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
    name: "rewrite dist-tags",
    createRewriter: () =>
      new JSONRewriter()
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
  {
    name: "combined packument mutations",
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

console.log(`json-rewriter benchmarks`);
console.log(`iterations=${iterations} warmup=${warmupIterations} chunkSize=${formatBytes(chunkSize)}`);
console.log("");

for (const fixture of fixtures) {
  console.log(`${fixture.name} packument (${formatBytes(fixture.bytes.byteLength)})`);
  console.log("case                              mean       p50        p95        min        max        throughput     output");

  for (const benchmarkCase of cases) {
    const samples = await runCase(fixture.bytes, benchmarkCase);
    printResult(benchmarkCase.name, fixture.bytes.byteLength, samples);
  }

  console.log("");
}

async function runCase(input: Uint8Array, benchmarkCase: BenchmarkCase): Promise<Sample[]> {
  for (let i = 0; i < warmupIterations; i += 1) {
    await runOnce(input, benchmarkCase);
  }

  const samples: Sample[] = [];
  for (let i = 0; i < iterations; i += 1) {
    Bun.gc(true);
    samples.push(await runOnce(input, benchmarkCase));
  }
  return samples;
}

async function runOnce(input: Uint8Array, benchmarkCase: BenchmarkCase): Promise<Sample> {
  const response = responseFromBytes(input);
  const startedAt = performance.now();

  if (benchmarkCase.name === "baseline response.arrayBuffer()") {
    const output = await response.arrayBuffer();
    return { durationMs: performance.now() - startedAt, outputBytes: output.byteLength };
  }

  const rewritten = benchmarkCase.createRewriter().transform(response);
  const output = await rewritten.arrayBuffer();
  return { durationMs: performance.now() - startedAt, outputBytes: output.byteLength };
}

function responseFromBytes(input: Uint8Array): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
          controller.enqueue(input.slice(offset, Math.min(offset + chunkSize, input.byteLength)));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function loadPackument(packageName: string): Promise<DocumentFixture> {
  const cachePath = `${CACHE_DIR}/${packageName.replaceAll("/", "__")}.json`;
  const cached = Bun.file(cachePath);

  if (await cached.exists()) {
    return { name: packageName, bytes: new Uint8Array(await cached.arrayBuffer()) };
  }

  const response = await fetch(`https://registry.npmjs.org/${packageName}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${packageName} packument: ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(cachePath, bytes);
  return { name: packageName, bytes };
}

async function ensureCacheDir(): Promise<void> {
  const directory = Bun.file(CACHE_DIR);
  if (!(await directory.exists())) {
    await Bun.$`mkdir -p ${CACHE_DIR}`.quiet();
  }
}

function printResult(name: string, inputBytes: number, samples: Sample[]): void {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const mean = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const min = durations[0] ?? 0;
  const max = durations[durations.length - 1] ?? 0;
  const throughput = inputBytes / 1024 / 1024 / (mean / 1000);
  const outputBytes = samples[samples.length - 1]?.outputBytes ?? 0;

  console.log(
    `${name.padEnd(33)} ${formatMs(mean).padStart(9)} ${formatMs(p50).padStart(9)} ${formatMs(p95).padStart(9)} ${formatMs(min).padStart(9)} ${formatMs(max).padStart(9)} ${`${throughput.toFixed(1)} MiB/s`.padStart(14)} ${formatBytes(outputBytes).padStart(10)}`,
  );
}

function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * value))] ?? 0;
}

function readPositiveIntegerFlag(name: string, fallback: number): number {
  return readIntegerFlag(name, fallback, 1);
}

function readIntegerFlag(name: string, fallback: number, minimum: number): number {
  const index = Bun.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  const raw = Bun.argv[index + 1];
  const value = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
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
