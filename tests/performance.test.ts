import { describe, expect, test } from "bun:test";
import { JSONRewriter } from "./index";

const CACHE_DIR = ".benchdata";
const PACKAGE_NAME = "wrangler";
const CHUNK_SIZE = 64 * 1024;
const PACKAGE_REGISTRY_ORIGIN = "https://registry.npmjs.org/";
const MIN_THROUGHPUT_MIB_PER_SECOND = 50;

interface PerfCase {
  name: string;
  createRewriter: () => JSONRewriter;
  validate: (output: Record<string, unknown>) => void;
}

interface PerfResult {
  name: string;
  durationMs: number;
  throughputMiBps: number;
  outputBytes: number;
}

describe("large document performance", () => {
  test(
    "rewrites the wrangler npm packument quickly enough",
    async () => {
      const input = await loadPackument(PACKAGE_NAME);
      const cases: PerfCase[] = [
        {
          name: "pass-through",
          createRewriter: () => new JSONRewriter(),
          validate(output) {
            expect(output.name).toBe(PACKAGE_NAME);
            expect(output.versions).toBeDefined();
          },
        },
        {
          name: "remove integrity fields",
          createRewriter: () =>
            new JSONRewriter().on("$..integrity", {
              value(node) {
                node.remove();
              },
            }),
          validate(output) {
            expect(JSON.stringify(output)).not.toContain('"integrity"');
          },
        },
        {
          name: "rewrite tarball urls",
          createRewriter: () =>
            new JSONRewriter().on("$..tarball", {
              string(node) {
                node.replace(node.value.replace(PACKAGE_REGISTRY_ORIGIN, "https://cache.example.com/npm/"));
              },
            }),
          validate(output) {
            const text = JSON.stringify(output);
            expect(text).toContain("https://cache.example.com/npm/");
            expect(text).not.toContain(`${PACKAGE_REGISTRY_ORIGIN}${PACKAGE_NAME}/-/`);
          },
        },
        {
          name: "remove versions subtree",
          createRewriter: () =>
            new JSONRewriter().on("$.versions", {
              object(node) {
                node.remove();
              },
            }),
          validate(output) {
            expect(output.versions).toBeUndefined();
            expect(output.time).toBeDefined();
          },
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
          validate(output) {
            const distTags = output["dist-tags"] as Record<string, unknown>;
            expect(distTags.benchmarked).toBe(true);
            expect(distTags.source).toBe("json-rewriter");
            expect(String(distTags.latest)).toStartWith("v");
            expect(JSON.stringify(output)).not.toContain('"integrity"');
          },
        },
      ];

      const results: PerfResult[] = [];
      for (const perfCase of cases) {
        Bun.gc(true);
        const startedAt = performance.now();
        const outputBytes = await perfCase.createRewriter().transform(responseFromBytes(input)).arrayBuffer();
        const durationMs = performance.now() - startedAt;
        const throughputMiBps = input.byteLength / 1024 / 1024 / (durationMs / 1000);

        const output = JSON.parse(new TextDecoder().decode(outputBytes)) as Record<string, unknown>;
        perfCase.validate(output);

        results.push({
          name: perfCase.name,
          durationMs,
          throughputMiBps,
          outputBytes: outputBytes.byteLength,
        });
        expect(throughputMiBps).toBeGreaterThan(MIN_THROUGHPUT_MIB_PER_SECOND);
      }

      console.table(
        results.map((result) => ({
          case: result.name,
          duration: `${result.durationMs.toFixed(2)}ms`,
          throughput: `${result.throughputMiBps.toFixed(1)} MiB/s`,
          output: formatBytes(result.outputBytes),
        })),
      );
    },
    120_000,
  );
});

function responseFromBytes(input: Uint8Array): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < input.byteLength; offset += CHUNK_SIZE) {
          controller.enqueue(input.slice(offset, Math.min(offset + CHUNK_SIZE, input.byteLength)));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
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

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} KiB`;
  }
  return `${value} B`;
}
