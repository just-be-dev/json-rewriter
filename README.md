# json-rewriter

A dependency-free streaming JSON rewriter in TypeScript using Web Streams, modeled after Cloudflare's `HTMLRewriter` API.

It processes one JSON document as a stream and emits minified JSON. It does not call `JSON.parse()` on the full body, so normal rewrites use bounded memory relative to nesting depth and current token size.

## Install

```bash
bun install
```

## Example

```ts
import { JSONRewriter } from "./index";

const response = await fetch("https://example.com/data.json");

const rewritten = new JSONRewriter()
  .on("$.users[*].email", {
    string(node) {
      node.replace(node.value.toLowerCase());
    },
  })
  .on("$..password", {
    value(node) {
      node.remove();
    },
  })
  .transform(response);
```

## API

```ts
new JSONRewriter()
  .on(selector, handler)
  .transform(response);
```

`transform()` returns a new `Response` with a streamed body. It preserves status, status text, and headers, but removes `content-length` because output size can change.

Handlers are synchronous in this version.

```ts
type JSONHandler = {
  value?(node): void;
  object?(node): void;
  array?(node): void;
  string?(node): void;
  number?(node): void;
  boolean?(node): void;
  null?(node): void;
  key?(node): void;
};
```

## Node Operations

All value nodes support:

```ts
node.replace(value);
node.remove();
```

Object nodes support static entry insertion:

```ts
object.prepend("before", true);
object.append("after", false);
```

Array nodes support static item insertion:

```ts
array.prepend(0);
array.append(99);
```

Key nodes support renaming:

```ts
key.rename("newName");
```

Removing the root value emits `null` so the output remains valid JSON.

## Selectors

Supported selector subset:

```txt
$                  root
$.user.name        object properties
$["user-name"]     quoted object properties
$.users[0]         array index
$.users[*]         array wildcard
$.*                direct child wildcard
$..id              recursive property match
```

Not supported yet:

```txt
[?()]              filters
[start:end]        slices
[-1]               negative indexes
```

Those require buffering or more complex stream semantics.

## Streaming Model

The rewriter tokenizes JSON incrementally with `TextDecoder`, tracks the current path and container stack, and writes normalized minified JSON. It does not preserve whitespace or original string escape style.

Bounded-memory operations include:

```ts
node.replace(value);
node.remove();
object.prepend(key, value);
object.append(key, value);
array.prepend(value);
array.append(value);
key.rename(name);
```

Subtree removal and replacement skip the incoming subtree token stream instead of buffering it.

## Test

```bash
mise run test
```

Run just the large-document performance test:

```bash
mise run perf
```

Memory profiling tests run as part of `mise run test`. They stream the same large document through representative rewrites, drain the output without buffering it, and report peak RSS, heap, external memory, ArrayBuffer memory, and retained RSS after GC. Run them on their own with:

```bash
mise run memory
```

You can make the memory profile fail when peak RSS growth exceeds a budget:

```bash
MEMORY_MAX_RSS_DELTA_MB=128 mise run memory
```

## Regression gate

CI runs a regression gate that fails when a change makes the rewriter meaningfully slower or starts buffering memory it used to stream:

```bash
mise run regression
```

It samples every scenario over many iterations and compares the medians against committed baselines in `regression/baselines.json`. To stay portable across machines (a CI runner is several times slower than a dev laptop), it never asserts on raw numbers — only on machine-independent ratios:

- **Performance** — each mutation case's throughput as a fraction of the pass-through rewrite measured in the same iteration. Pass-through runs the full tokenizer and serializer with no mutation work, so it tracks CPU speed and cancels out of the ratio.
- **Memory** — peak external memory as a fraction of the document size. Streaming keeps this near 1× (the live input); a regression that buffers the whole output pushes it toward 2×. Pass-through memory is reported but not gated — it is a reference point, not a cost we ship.

When you intentionally change performance characteristics, regenerate and commit the baselines:

```bash
mise run update-baselines
```

Tune it with `REGRESSION_ITERATIONS`, `REGRESSION_WARMUP`, `REGRESSION_PERF_TOLERANCE` (default `0.35`), `REGRESSION_MEMORY_TOLERANCE` (default `0.5`), and `REGRESSION_MEMORY_MIN_CEILING` (default `0.25`). The last sets a floor under the memory ceiling so streaming-drop cases — whose peak memory is a tiny, platform-dependent constant rather than a fraction of the document — are only flagged if they approach whole-document buffering.

## Benchmark

```bash
mise run bench
```

The performance test, memory profile, and benchmark download the `wrangler` npm packument on first run, cache it in `.benchdata`, and measure streaming rewrite behavior for pass-through and representative mutations. The benchmark reports mean, p50, p95, min, max, throughput, and output size. You can tune it with `--iterations`, `--warmup`, and `--chunk-size`:

```bash
mise run bench -- --iterations 25 --warmup 5 --chunk-size 32768
```

## Typecheck

```bash
mise run typecheck
```
