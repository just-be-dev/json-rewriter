import { describe, expect, test } from "bun:test";
import { JSONRewriter } from "./index";

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
    expect(output).toBe('{"text":"café ☺"}');
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
    const output = new JSONRewriter().transform(chunkedResponse(['{"a":1,}']));
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
});
