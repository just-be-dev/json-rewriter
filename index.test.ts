import { describe, expect, test } from "bun:test";
import { JSONRewriter } from "./index";
import type { JSONValue, PathSegment } from "./src/types";

function chunkedResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    init,
  );
}

async function rewrite(input: string | string[], rewriter: JSONRewriter): Promise<string> {
  const response = chunkedResponse(Array.isArray(input) ? input : [input]);
  return await rewriter.transform(response).text();
}

describe("JSONRewriter", () => {
  test("minifies JSON while streaming chunked input", async () => {
    const output = await rewrite(['{ "a"', ' : 1, "b" : ', '[ true, null ] }'], new JSONRewriter());
    expect(output).toBe('{"a":1,"b":[true,null]}');
  });

  test("replaces string values by path", async () => {
    const output = await rewrite(
      '{"users":[{"email":"A@EXAMPLE.COM"},{"email":"B@EXAMPLE.COM"}]}',
      new JSONRewriter().on("$.users[*].email", {
        string(node) {
          node.replace(node.value.toLowerCase());
        },
      }),
    );

    expect(output).toBe('{"users":[{"email":"a@example.com"},{"email":"b@example.com"}]}');
  });

  test("removes object members without leaving dangling commas", async () => {
    const output = await rewrite(
      '{"a":1,"password":"secret","b":2}',
      new JSONRewriter().on("$..password", {
        value(node) {
          node.remove();
        },
      }),
    );

    expect(output).toBe('{"a":1,"b":2}');
  });

  test("removes array items without leaving dangling commas", async () => {
    const output = await rewrite(
      '[0,1,2,3]',
      new JSONRewriter().on("$[1]", {
        number(node) {
          node.remove();
        },
      }),
    );

    expect(output).toBe('[0,2,3]');
  });

  test("removes array edge items without dangling commas", async () => {
    expect(
      await rewrite(
        '[0,1,2]',
        new JSONRewriter().on('$[0]', {
          number(node) {
            node.remove();
          },
        }),
      ),
    ).toBe('[1,2]');

    expect(
      await rewrite(
        '[0,1,2]',
        new JSONRewriter().on('$[2]', {
          number(node) {
            node.remove();
          },
        }),
      ),
    ).toBe('[0,1]');

    expect(
      await rewrite(
        '[0]',
        new JSONRewriter().on('$[0]', {
          number(node) {
            node.remove();
          },
        }),
      ),
    ).toBe('[]');

    expect(
      await rewrite(
        '[0,1,2]',
        new JSONRewriter()
          .on('$[0]', {
            number(node) {
              node.remove();
            },
          })
          .on('$[1]', {
            number(node) {
              node.remove();
            },
          }),
      ),
    ).toBe('[2]');
  });

  test("removes object edge members without dangling commas", async () => {
    expect(
      await rewrite(
        '{"a":1,"b":2,"c":3}',
        new JSONRewriter().on('$.a', {
          number(node) {
            node.remove();
          },
        }),
      ),
    ).toBe('{"b":2,"c":3}');

    expect(
      await rewrite(
        '{"a":1,"b":2,"c":3}',
        new JSONRewriter().on('$.c', {
          number(node) {
            node.remove();
          },
        }),
      ),
    ).toBe('{"a":1,"b":2}');

    expect(
      await rewrite(
        '{"a":1}',
        new JSONRewriter().on('$.a', {
          number(node) {
            node.remove();
          },
        }),
      ),
    ).toBe('{}');

    expect(
      await rewrite(
        '{"a":1,"b":2,"c":3}',
        new JSONRewriter()
          .on('$.a', {
            number(node) {
              node.remove();
            },
          })
          .on('$.b', {
            number(node) {
              node.remove();
            },
          }),
      ),
    ).toBe('{"c":3}');
  });

  test("removes whole subtrees without buffering them", async () => {
    const output = await rewrite(
      '{"keep":true,"drop":{"a":[1,2,{"b":3}]},"after":false}',
      new JSONRewriter().on("$.drop", {
        object(node) {
          node.remove();
        },
      }),
    );

    expect(output).toBe('{"keep":true,"after":false}');
  });

  test("replaces whole subtrees", async () => {
    const output = await rewrite(
      '{"data":{"large":[1,2,3]},"ok":true}',
      new JSONRewriter().on("$.data", {
        object(node) {
          node.replace({ replaced: true });
        },
      }),
    );

    expect(output).toBe('{"data":{"replaced":true},"ok":true}');
  });

  test("renames object keys", async () => {
    const output = await rewrite(
      '{"user":{"first_name":"Ada"}}',
      new JSONRewriter().on("$.user.first_name", {
        key(node) {
          node.rename("firstName");
        },
      }),
    );

    expect(output).toBe('{"user":{"firstName":"Ada"}}');
  });

  test("prepends and appends object entries and array items", async () => {
    const output = await rewrite(
      '{"items":[2],"meta":{"middle":true}}',
      new JSONRewriter()
        .on("$.items", {
          array(node) {
            node.prepend(1).append(3);
          },
        })
        .on("$.meta", {
          object(node) {
            node.prepend("first", false).append("last", true);
          },
        }),
    );

    expect(output).toBe('{"items":[1,2,3],"meta":{"first":false,"middle":true,"last":true}}');
  });

  test("supports quoted selectors and recursive matches", async () => {
    const output = await rewrite(
      '{"user-name":"Ada","nested":{"id":1,"child":{"id":2}}}',
      new JSONRewriter()
        .on('$["user-name"]', {
          string(node) {
            node.replace("Grace");
          },
        })
        .on("$..id", {
          number(node) {
            node.replace(node.value + 10);
          },
        }),
    );

    expect(output).toBe('{"user-name":"Grace","nested":{"id":11,"child":{"id":12}}}');
  });

  test("handles UTF-8 and JSON escapes across chunk boundaries", async () => {
    const output = await rewrite(['{"text":"caf', 'é \\u263', 'A"}'], new JSONRewriter());
    expect(output).toBe('{"text":"café \\u263A"}');
  });

  test("replaces removed root with null", async () => {
    const output = await rewrite(
      '[1,2,3]',
      new JSONRewriter().on("$", {
        array(node) {
          node.remove();
        },
      }),
    );

    expect(output).toBe('null');
  });

  test("preserves response metadata and removes content-length", async () => {
    const input = chunkedResponse(['{"a":1}'], {
      status: 201,
      statusText: "Created",
      headers: {
        "content-type": "application/json",
        "content-length": "7",
        "x-test": "yes",
      },
    });

    const output = new JSONRewriter().transform(input);
    expect(output.status).toBe(201);
    expect(output.statusText).toBe("Created");
    expect(output.headers.get("content-type")).toBe("application/json");
    expect(output.headers.get("x-test")).toBe("yes");
    expect(output.headers.has("content-length")).toBe(false);
    expect(await output.text()).toBe('{"a":1}');
  });

  test("errors transformed body on invalid JSON", async () => {
    const output = new JSONRewriter()
      .on('$.a', {
        number() {},
      })
      .transform(chunkedResponse(['{"a":1,}']));
    await expect(output.text()).rejects.toThrow();
  });

  test("errors transformed body on invalid JSON inside removed subtrees", async () => {
    const output = new JSONRewriter()
      .on("$.drop", {
        object(node) {
          node.remove();
        },
      })
      .transform(chunkedResponse(['{"drop":{"a":1,},"keep":true}']));

    await expect(output.text()).rejects.toThrow();
  });

  test("errors transformed body on invalid string escapes inside removed subtrees", async () => {
    const output = new JSONRewriter()
      .on("$.drop", {
        object(node) {
          node.remove();
        },
      })
      .transform(chunkedResponse(['{"drop":{"a":"\\x"},"keep":true}']));

    await expect(output.text()).rejects.toThrow();
  });

  test("errors transformed body when handler throws", async () => {
    const output = new JSONRewriter()
      .on("$.a", {
        number() {
          throw new Error("boom");
        },
      })
      .transform(chunkedResponse(['{"a":1}']));

    await expect(output.text()).rejects.toThrow("boom");
  });

  test("fuzzes passthrough equivalence with whitespace and chunking", async () => {
    const random = createRandom(0x12345678);

    for (let iteration = 0; iteration < 150; iteration += 1) {
      const inputValue = generateJSONValue(random);
      const input = addInsignificantWhitespace(JSON.stringify(inputValue), random);
      const output = await rewrite(chunkString(input, random), new JSONRewriter());

      expect(JSON.parse(output)).toEqual(JSON.parse(input));
    }
  });

  test("fuzzes exact-path removals", async () => {
    const random = createRandom(0x9abcdef0);

    for (let iteration = 0; iteration < 150; iteration += 1) {
      const inputValue = generateJSONValue(random);
      const paths = collectPaths(inputValue);
      const path = paths[randomInt(random, paths.length)] ?? [];
      const expected = cloneJSON(inputValue);
      removeAtPath(expected, path);
      const input = addInsignificantWhitespace(JSON.stringify(inputValue), random);

      const output = await rewrite(
        chunkString(input, random),
        new JSONRewriter().on(selectorForPath(path), {
          value(node) {
            node.remove();
          },
        }),
      );

      expect(JSON.parse(output)).toEqual(path.length === 0 ? null : expected);
    }
  });

  test("fuzzes exact-path replacements", async () => {
    const random = createRandom(0x0badcafe);

    for (let iteration = 0; iteration < 150; iteration += 1) {
      const inputValue = generateJSONValue(random);
      const replacement = generateJSONValue(random, 2);
      const paths = collectPaths(inputValue);
      const path = paths[randomInt(random, paths.length)] ?? [];
      const expected = cloneJSON(inputValue);
      replaceAtPath(expected, path, replacement);
      const input = addInsignificantWhitespace(JSON.stringify(inputValue), random);

      const output = await rewrite(
        chunkString(input, random),
        new JSONRewriter().on(selectorForPath(path), {
          value(node) {
            node.replace(replacement);
          },
        }),
      );

      expect(JSON.parse(output)).toEqual(path.length === 0 ? replacement : expected);
    }
  });

  test("fuzzes key renames", async () => {
    const random = createRandom(0xfeedface);

    for (let iteration = 0; iteration < 150; iteration += 1) {
      const inputValue = generateJSONObjectWithMember(random);
      const keyPaths = collectObjectMemberPaths(inputValue);
      const path = keyPaths[randomInt(random, keyPaths.length)];
      if (!path) {
        continue;
      }
      const expected = cloneJSON(inputValue);
      const newName = uniqueKeyAtParent(expected, path, random);
      renameAtPath(expected, path, newName);
      const input = addInsignificantWhitespace(JSON.stringify(inputValue), random);

      const output = await rewrite(
        chunkString(input, random),
        new JSONRewriter().on(selectorForPath(path), {
          key(node) {
            node.rename(newName);
          },
        }),
      );

      expect(JSON.parse(output)).toEqual(expected);
    }
  });
});

type Random = () => number;

function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomInt(random: Random, exclusiveMax: number): number {
  return Math.floor(random() * exclusiveMax);
}

function generateJSONValue(random: Random, maxDepth = 4): JSONValue {
  if (maxDepth <= 0) {
    return generateScalar(random);
  }

  const type = randomInt(random, 6);
  if (type <= 2) {
    return generateScalar(random);
  }
  if (type === 3) {
    const length = randomInt(random, 5);
    const array: JSONValue[] = [];
    for (let index = 0; index < length; index += 1) {
      array.push(generateJSONValue(random, maxDepth - 1));
    }
    return array;
  }

  const length = randomInt(random, 5);
  const object: Record<string, JSONValue> = {};
  for (let index = 0; index < length; index += 1) {
    object[generateKey(random, index)] = generateJSONValue(random, maxDepth - 1);
  }
  return object;
}

function generateJSONObjectWithMember(random: Random): Record<string, JSONValue> {
  const value = generateJSONValue(random);
  if (isJSONObject(value) && collectObjectMemberPaths(value).length > 0) {
    return value;
  }
  return { root: value, other: generateJSONValue(random, 2) };
}

function generateScalar(random: Random): JSONValue {
  switch (randomInt(random, 4)) {
    case 0:
      return null;
    case 1:
      return random() < 0.5;
    case 2:
      return randomInt(random, 2000) - 1000;
    default:
      return generateString(random);
  }
}

function generateString(random: Random): string {
  const parts = ["alpha", "", "space value", "quote\"value", "slash\\value", "unicode café", "line\nbreak"];
  return parts[randomInt(random, parts.length)] ?? "";
}

function generateKey(random: Random, index: number): string {
  const keys = ["a", "b", "hyphen-key", "space key", "quote\"key", "unicode café"];
  return `${keys[randomInt(random, keys.length)] ?? "k"}_${index}`;
}

function addInsignificantWhitespace(json: string, random: Random): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const char = json[index] ?? "";
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += maybeWhitespace(random) + char;
      continue;
    }

    if (char === "{" || char === "[" || char === ":" || char === ",") {
      output += maybeWhitespace(random) + char + maybeWhitespace(random);
      continue;
    }
    if (char === "}" || char === "]") {
      output += maybeWhitespace(random) + char;
      continue;
    }

    output += char;
  }

  return maybeWhitespace(random) + output + maybeWhitespace(random);
}

function maybeWhitespace(random: Random): string {
  const runs = ["", " ", "\n", "\t", "\r\n  "];
  return random() < 0.35 ? (runs[randomInt(random, runs.length)] ?? "") : "";
}

function chunkString(input: string, random: Random): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < input.length) {
    const size = 1 + randomInt(random, 17);
    chunks.push(input.slice(index, index + size));
    index += size;
  }
  return chunks.length > 0 ? chunks : [""];
}

function collectPaths(value: JSONValue, path: PathSegment[] = [], paths: PathSegment[][] = []): PathSegment[][] {
  paths.push([...path]);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectPaths(value[index] as JSONValue, [...path, index], paths);
    }
  } else if (isJSONObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectPaths(child, [...path, key], paths);
    }
  }
  return paths;
}

function collectObjectMemberPaths(value: JSONValue, path: PathSegment[] = [], paths: PathSegment[][] = []): PathSegment[][] {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectObjectMemberPaths(value[index] as JSONValue, [...path, index], paths);
    }
  } else if (isJSONObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      paths.push(childPath);
      collectObjectMemberPaths(child, childPath, paths);
    }
  }
  return paths;
}

function selectorForPath(path: readonly PathSegment[]): string {
  let selector = "$";
  for (const segment of path) {
    if (typeof segment === "number") {
      selector += `[${segment}]`;
    } else {
      selector += `[${JSON.stringify(segment)}]`;
    }
  }
  return selector;
}

function cloneJSON<T extends JSONValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function removeAtPath(root: JSONValue, path: readonly PathSegment[]): void {
  if (path.length === 0) {
    return;
  }
  const parent = getParent(root, path);
  const segment = path[path.length - 1];
  if (Array.isArray(parent) && typeof segment === "number") {
    parent.splice(segment, 1);
  } else if (isJSONObject(parent) && typeof segment === "string") {
    delete parent[segment];
  }
}

function replaceAtPath(root: JSONValue, path: readonly PathSegment[], replacement: JSONValue): void {
  if (path.length === 0) {
    return;
  }
  const parent = getParent(root, path);
  const segment = path[path.length - 1];
  if (Array.isArray(parent) && typeof segment === "number") {
    parent[segment] = replacement;
  } else if (isJSONObject(parent) && typeof segment === "string") {
    parent[segment] = replacement;
  }
}

function renameAtPath(root: JSONValue, path: readonly PathSegment[], newName: string): void {
  const parent = getParent(root, path);
  const segment = path[path.length - 1];
  if (!isJSONObject(parent) || typeof segment !== "string") {
    throw new Error("Expected object member path");
  }
  const value = parent[segment];
  delete parent[segment];
  parent[newName] = value as JSONValue;
}

function uniqueKeyAtParent(root: JSONValue, path: readonly PathSegment[], random: Random): string {
  const parent = getParent(root, path);
  if (!isJSONObject(parent)) {
    throw new Error("Expected object parent");
  }
  let key = "renamed";
  while (key in parent) {
    key = `renamed_${randomInt(random, 1_000_000)}`;
  }
  return key;
}

function getParent(root: JSONValue, path: readonly PathSegment[]): JSONValue {
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment] as JSONValue;
    } else if (isJSONObject(current) && typeof segment === "string") {
      current = current[segment] as JSONValue;
    } else {
      throw new Error("Invalid path");
    }
  }
  return current;
}

function isJSONObject(value: JSONValue): value is Record<string, JSONValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
