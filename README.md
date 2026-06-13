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
bun test
```

Performance tests are opt-in because they process a large npm packument and have timing-sensitive assertions:

```bash
bun run perf
```

## Benchmark

```bash
bun run bench
```

The performance test and benchmark download the `wrangler` npm packument on first run, cache it in `.benchdata`, and measure streaming rewrite throughput for pass-through and representative mutations. The benchmark reports mean, p50, p95, min, max, throughput, and output size. You can tune it with `--iterations`, `--warmup`, and `--chunk-size`:

```bash
bun run bench -- --iterations 25 --warmup 5 --chunk-size 32768
```

## Typecheck

```bash
bun run typecheck
```
