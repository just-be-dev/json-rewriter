import { compileSelector, type CompiledSelector } from "./selectors";
import { JSONTokenizer, type JSONToken } from "./tokenizer";
import type {
  JSONArrayNode,
  JSONHandler,
  JSONKeyNode,
  JSONNode,
  JSONObjectNode,
  JSONScalarNode,
  JSONValue,
  PathSegment,
} from "./types";

interface HandlerRegistration {
  selector: CompiledSelector;
  handler: JSONHandler;
}

type ObjectState = "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
type ArrayState = "valueOrEnd" | "value" | "commaOrEnd";

interface ObjectFrame {
  type: "object";
  path: PathSegment[];
  state: ObjectState;
  first: boolean;
  pendingKey?: string;
  pendingOutputKey?: string;
  appendEntries: ObjectEntry[];
}

interface ArrayFrame {
  type: "array";
  path: PathSegment[];
  state: ArrayState;
  first: boolean;
  index: number;
  appendItems: JSONValue[];
}

type Frame = ObjectFrame | ArrayFrame;
type ObjectEntry = { key: string; value: JSONValue };

export class JSONRewriter {
  private readonly handlers: HandlerRegistration[] = [];
  private readonly keyHandlers: HandlerRegistration[] = [];
  private readonly valueHandlers: HandlerRegistration[] = [];

  on(selector: string, handler: JSONHandler): this {
    const registration = { selector: compileSelector(selector), handler };
    this.handlers.push(registration);
    if (handler.key) {
      this.keyHandlers.push(registration);
    }
    if (handler.value || handler.object || handler.array || handler.string || handler.number || handler.boolean || handler.null) {
      this.valueHandlers.push(registration);
    }
    return this;
  }

  transform(response: Response): Response {
    if (!response.body) {
      throw new TypeError("Cannot transform a Response without a body");
    }

    const headers = new Headers(response.headers);
    headers.delete("content-length");

    const tokenizer = new JSONTokenizer();
    const decoder = new TextDecoder();
    let processor: StreamingProcessor | undefined;
    let output: BufferedOutput | undefined;

    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        start: (controller) => {
          output = new BufferedOutput((chunk) => controller.enqueue(chunk));
          processor = new StreamingProcessor(this.keyHandlers, this.valueHandlers, (chunk) => output?.write(chunk));
        },
        transform(chunk) {
          const text = decoder.decode(chunk, { stream: true });
          tokenizer.feedTokens(text, false, (token) => processor?.process(token));
          output?.flushReady();
        },
        flush() {
          const tail = decoder.decode();
          tokenizer.feedTokens(tail, true, (token) => processor?.process(token));
          processor?.finish();
          output?.flush();
        },
      }),
    );

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

class BufferedOutput {
  private static readonly FLUSH_THRESHOLD = 64 * 1024;
  private readonly encoder = new TextEncoder();
  private chunks: string[] = [];
  private size = 0;

  constructor(private readonly emit: (chunk: Uint8Array) => void) {}

  write(chunk: string): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    this.flushReady();
  }

  flushReady(): void {
    if (this.size >= BufferedOutput.FLUSH_THRESHOLD) {
      this.flush();
    }
  }

  flush(): void {
    if (this.size === 0) {
      return;
    }
    this.emit(this.encoder.encode(this.chunks.join("")));
    this.chunks = [];
    this.size = 0;
  }
}

class StreamingProcessor {
  private readonly stack: Frame[] = [];
  private rootState: "value" | "done" = "value";
  private skipValidator: SkipValidator | undefined;

  constructor(
    private readonly keyHandlers: readonly HandlerRegistration[],
    private readonly valueHandlers: readonly HandlerRegistration[],
    private readonly emit: (chunk: string) => void,
  ) {}

  process(token: JSONToken): void {
    if (this.skipValidator) {
      if (this.skipValidator.process(token)) {
        this.skipValidator = undefined;
      }
      return;
    }

    const frame = this.currentFrame();
    if (!frame) {
      this.processRootToken(token);
      return;
    }

    if (frame.type === "object") {
      this.processObjectToken(frame, token);
      return;
    }

    this.processArrayToken(frame, token);
  }

  finish(): void {
    if (this.skipValidator || this.stack.length > 0 || this.rootState !== "done") {
      throw new SyntaxError("Unexpected end of JSON input");
    }
  }

  private processRootToken(token: JSONToken): void {
    if (this.rootState === "done") {
      throw new SyntaxError("Unexpected token after root JSON value");
    }

    if (!isValueToken(token)) {
      throw new SyntaxError("Expected root JSON value");
    }

    this.processValueToken(token, []);
  }

  private processObjectToken(frame: ObjectFrame, token: JSONToken): void {
    if (frame.state === "keyOrEnd" || frame.state === "key") {
      if (token.type === "endObject") {
        if (frame.state === "key") {
          throw new SyntaxError("Expected object key after ,");
        }
        this.closeObject(frame);
        return;
      }
      if (token.type !== "string") {
        throw new SyntaxError("Expected object key");
      }
      const path = [...frame.path, token.value];
      let outputKey = token.value;
      if (this.keyHandlers.length > 0) {
        const key = new KeyNode(path, token.value);
        this.applyKeyHandlers(path, key);
        outputKey = key.name;
      }
      frame.pendingKey = token.value;
      frame.pendingOutputKey = outputKey;
      frame.state = "colon";
      return;
    }

    if (frame.state === "colon") {
      if (token.type !== "colon") {
        throw new SyntaxError("Expected : after object key");
      }
      frame.state = "value";
      return;
    }

    if (frame.state === "value") {
      if (!isValueToken(token)) {
        throw new SyntaxError("Expected object value");
      }
      this.processValueToken(token, [...frame.path, requirePendingKey(frame)]);
      return;
    }

    if (token.type === "comma") {
      frame.state = "key";
      return;
    }
    if (token.type === "endObject") {
      this.closeObject(frame);
      return;
    }
    throw new SyntaxError("Expected , or } after object value");
  }

  private processArrayToken(frame: ArrayFrame, token: JSONToken): void {
    if (frame.state === "valueOrEnd") {
      if (token.type === "endArray") {
        this.closeArray(frame);
        return;
      }
      if (!isValueToken(token)) {
        throw new SyntaxError("Expected array value");
      }
      this.processValueToken(token, [...frame.path, frame.index]);
      return;
    }

    if (frame.state === "value") {
      if (!isValueToken(token)) {
        throw new SyntaxError("Expected array value");
      }
      this.processValueToken(token, [...frame.path, frame.index]);
      return;
    }

    if (token.type === "comma") {
      frame.state = "value";
      return;
    }
    if (token.type === "endArray") {
      this.closeArray(frame);
      return;
    }
    throw new SyntaxError("Expected , or ] after array value");
  }

  private processValueToken(token: JSONToken, path: PathSegment[]): void {
    if (token.type === "startObject") {
      if (this.valueHandlers.length === 0) {
        this.acceptValueStart(false);
        this.emit("{");
        this.stack.push({
          type: "object",
          path,
          state: "keyOrEnd",
          first: true,
          appendEntries: [],
        });
        return;
      }

      const node = new ContainerNode(path) as JSONObjectNodeImpl;
      this.applyValueHandlers(path, node, "object");
      this.acceptValueStart(node.removed);
      if (node.replacement !== undefined) {
        this.emit(node.replacement);
        this.skipValidator = new SkipValidator("object");
        return;
      }
      if (node.removed) {
        this.emitRootNullIfNeeded(path);
        this.skipValidator = new SkipValidator("object");
        return;
      }

      this.emit("{");
      const frame: ObjectFrame = {
        type: "object",
        path,
        state: "keyOrEnd",
        first: true,
        appendEntries: node.appendEntries,
      };
      for (const entry of node.prependEntries) {
        writeObjectEntry(frame, entry, this.emit);
      }
      this.stack.push(frame);
      return;
    }

    if (token.type === "startArray") {
      if (this.valueHandlers.length === 0) {
        this.acceptValueStart(false);
        this.emit("[");
        this.stack.push({
          type: "array",
          path,
          state: "valueOrEnd",
          first: true,
          index: 0,
          appendItems: [],
        });
        return;
      }

      const node = new ContainerNode(path) as JSONArrayNodeImpl;
      this.applyValueHandlers(path, node, "array");
      this.acceptValueStart(node.removed);
      if (node.replacement !== undefined) {
        this.emit(node.replacement);
        this.skipValidator = new SkipValidator("array");
        return;
      }
      if (node.removed) {
        this.emitRootNullIfNeeded(path);
        this.skipValidator = new SkipValidator("array");
        return;
      }

      this.emit("[");
      const frame: ArrayFrame = {
        type: "array",
        path,
        state: "valueOrEnd",
        first: true,
        index: 0,
        appendItems: node.appendItems,
      };
      for (const item of node.prependItems) {
        writeArrayItem(frame, item, this.emit);
      }
      this.stack.push(frame);
      return;
    }

    if (this.valueHandlers.length === 0) {
      this.acceptValueStart(false);
      this.emit(tokenToJSON(token));
      return;
    }

    const scalar = createScalarNode(token, path);
    this.applyValueHandlers(path, scalar, scalarKind(token));
    this.acceptValueStart(scalar.removed);
    if (scalar.replacement !== undefined) {
      this.emit(scalar.replacement);
      return;
    }
    if (scalar.removed) {
      this.emitRootNullIfNeeded(path);
      return;
    }
    this.emit(tokenToJSON(token));
  }

  private acceptValueStart(removed: boolean): void {
    const parent = this.currentFrame();
    if (!parent) {
      this.rootState = "done";
      return;
    }

    if (parent.type === "object") {
      const key = parent.pendingOutputKey;
      if (key === undefined) {
        throw new SyntaxError("Missing object key");
      }
      if (!removed) {
        if (!parent.first) {
          this.emit(",");
        }
        this.emit(`${JSON.stringify(key)}:`);
        parent.first = false;
      }
      parent.pendingKey = undefined;
      parent.pendingOutputKey = undefined;
      parent.state = "commaOrEnd";
      return;
    }

    if (!removed) {
      if (!parent.first) {
        this.emit(",");
      }
      parent.first = false;
    }
    parent.index += 1;
    parent.state = "commaOrEnd";
  }

  private closeObject(frame: ObjectFrame): void {
    for (const entry of frame.appendEntries) {
      writeObjectEntry(frame, entry, this.emit);
    }
    this.emit("}");
    this.stack.pop();
  }

  private closeArray(frame: ArrayFrame): void {
    for (const item of frame.appendItems) {
      writeArrayItem(frame, item, this.emit);
    }
    this.emit("]");
    this.stack.pop();
  }

  private applyKeyHandlers(path: readonly PathSegment[], node: KeyNode): void {
    for (const registration of this.keyHandlers) {
      if (registration.selector.matches(path)) {
        registration.handler.key?.(node);
      }
    }
  }

  private applyValueHandlers(path: readonly PathSegment[], node: MutableNode | ContainerNode, kind: ValueKind): void {
    for (const registration of this.valueHandlers) {
      if (!registration.selector.matches(path)) {
        continue;
      }
      registration.handler.value?.(node);
      if (kind === "object") {
        registration.handler.object?.(node as unknown as JSONObjectNode);
      } else if (kind === "array") {
        registration.handler.array?.(node as unknown as JSONArrayNode);
      } else if (kind === "string") {
        registration.handler.string?.(node as JSONScalarNode<string>);
      } else if (kind === "number") {
        registration.handler.number?.(node as JSONScalarNode<number>);
      } else if (kind === "boolean") {
        registration.handler.boolean?.(node as JSONScalarNode<boolean>);
      } else {
        registration.handler.null?.(node as JSONScalarNode<null>);
      }
    }
  }

  private emitRootNullIfNeeded(path: readonly PathSegment[]): void {
    if (path.length === 0) {
      this.emit("null");
    }
  }

  private currentFrame(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }
}

type SkipFrame =
  | { type: "object"; state: ObjectState }
  | { type: "array"; state: ArrayState };

class SkipValidator {
  private readonly stack: SkipFrame[];

  constructor(type: "object" | "array") {
    this.stack = type === "object" ? [{ type, state: "keyOrEnd" }] : [{ type, state: "valueOrEnd" }];
  }

  process(token: JSONToken): boolean {
    const frame = this.stack[this.stack.length - 1];
    if (!frame) {
      throw new SyntaxError("Unexpected token after skipped JSON value");
    }

    if (frame.type === "object") {
      this.processObject(frame, token);
    } else {
      this.processArray(frame, token);
    }

    return this.stack.length === 0;
  }

  private processObject(frame: SkipFrame & { type: "object" }, token: JSONToken): void {
    if (frame.state === "keyOrEnd" || frame.state === "key") {
      if (token.type === "endObject") {
        if (frame.state === "key") {
          throw new SyntaxError("Expected object key after ,");
        }
        this.stack.pop();
        return;
      }
      if (token.type !== "string") {
        throw new SyntaxError("Expected object key");
      }
      frame.state = "colon";
      return;
    }

    if (frame.state === "colon") {
      if (token.type !== "colon") {
        throw new SyntaxError("Expected : after object key");
      }
      frame.state = "value";
      return;
    }

    if (frame.state === "value") {
      this.processValue(token, frame);
      return;
    }

    if (token.type === "comma") {
      frame.state = "key";
      return;
    }
    if (token.type === "endObject") {
      this.stack.pop();
      return;
    }
    throw new SyntaxError("Expected , or } after object value");
  }

  private processArray(frame: SkipFrame & { type: "array" }, token: JSONToken): void {
    if (frame.state === "valueOrEnd") {
      if (token.type === "endArray") {
        this.stack.pop();
        return;
      }
      this.processValue(token, frame);
      return;
    }

    if (frame.state === "value") {
      this.processValue(token, frame);
      return;
    }

    if (token.type === "comma") {
      frame.state = "value";
      return;
    }
    if (token.type === "endArray") {
      this.stack.pop();
      return;
    }
    throw new SyntaxError("Expected , or ] after array value");
  }

  private processValue(token: JSONToken, parent: SkipFrame): void {
    if (!isValueToken(token)) {
      throw new SyntaxError("Expected JSON value");
    }

    if (parent.type === "object") {
      parent.state = "commaOrEnd";
    } else {
      parent.state = "commaOrEnd";
    }

    if (token.type === "startObject") {
      this.stack.push({ type: "object", state: "keyOrEnd" });
    } else if (token.type === "startArray") {
      this.stack.push({ type: "array", state: "valueOrEnd" });
    }
  }
}

type ValueKind = "object" | "array" | "string" | "number" | "boolean" | "null";

class MutableNode<T = JSONValue> implements JSONNode<T> {
  removed = false;
  replacement: string | undefined;

  constructor(
    readonly path: readonly PathSegment[],
    readonly value: T,
  ) {}

  replace(value: JSONValue): this {
    this.replacement = stringifyJSONValue(value);
    this.removed = false;
    return this;
  }

  remove(): this {
    this.removed = true;
    this.replacement = undefined;
    return this;
  }
}

class ContainerNode extends MutableNode<undefined> implements JSONObjectNode, JSONArrayNode {
  readonly prependEntries: ObjectEntry[] = [];
  readonly appendEntries: ObjectEntry[] = [];
  readonly prependItems: JSONValue[] = [];
  readonly appendItems: JSONValue[] = [];

  constructor(path: readonly PathSegment[]) {
    super(path, undefined);
  }

  prepend(keyOrValue: string | JSONValue, value?: JSONValue): this {
    if (typeof keyOrValue === "string" && arguments.length === 2) {
      stringifyJSONValue(value as JSONValue);
      this.prependEntries.push({ key: keyOrValue, value: value as JSONValue });
    } else {
      stringifyJSONValue(keyOrValue as JSONValue);
      this.prependItems.push(keyOrValue as JSONValue);
    }
    return this;
  }

  append(keyOrValue: string | JSONValue, value?: JSONValue): this {
    if (typeof keyOrValue === "string" && arguments.length === 2) {
      stringifyJSONValue(value as JSONValue);
      this.appendEntries.push({ key: keyOrValue, value: value as JSONValue });
    } else {
      stringifyJSONValue(keyOrValue as JSONValue);
      this.appendItems.push(keyOrValue as JSONValue);
    }
    return this;
  }
}

type JSONObjectNodeImpl = ContainerNode & JSONObjectNode;
type JSONArrayNodeImpl = ContainerNode & JSONArrayNode;

class KeyNode implements JSONKeyNode {
  constructor(
    readonly path: readonly PathSegment[],
    public name: string,
  ) {}

  rename(name: string): this {
    this.name = name;
    return this;
  }
}

function createScalarNode(token: JSONToken, path: readonly PathSegment[]): MutableNode {
  if (token.type === "string" || token.type === "number" || token.type === "boolean") {
    return new MutableNode(path, token.value);
  }
  if (token.type === "null") {
    return new MutableNode(path, null);
  }
  throw new TypeError("Expected scalar token");
}

function isValueToken(token: JSONToken): boolean {
  return token.type === "startObject" || token.type === "startArray" || token.type === "string" || token.type === "number" || token.type === "boolean" || token.type === "null";
}

function scalarKind(token: JSONToken): ValueKind {
  if (token.type === "string" || token.type === "number" || token.type === "boolean") {
    return token.type;
  }
  if (token.type === "null") {
    return "null";
  }
  throw new TypeError("Expected scalar token");
}

function tokenToJSON(token: JSONToken): string {
  if (token.type === "string") {
    return token.output;
  }
  if (token.type === "number") {
    return token.raw;
  }
  if (token.type === "boolean") {
    return token.value ? "true" : "false";
  }
  if (token.type === "null") {
    return "null";
  }
  throw new TypeError("Expected scalar token");
}

function writeObjectEntry(frame: ObjectFrame, entry: ObjectEntry, emit: (chunk: string) => void): void {
  if (!frame.first) {
    emit(",");
  }
  emit(`${JSON.stringify(entry.key)}:${stringifyJSONValue(entry.value)}`);
  frame.first = false;
}

function writeArrayItem(frame: ArrayFrame, value: JSONValue, emit: (chunk: string) => void): void {
  if (!frame.first) {
    emit(",");
  }
  emit(stringifyJSONValue(value));
  frame.first = false;
}

function stringifyJSONValue(value: JSONValue): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("Replacement value must be valid JSON");
  }
  return json;
}

function requirePendingKey(frame: ObjectFrame): string {
  if (frame.pendingKey === undefined) {
    throw new SyntaxError("Missing object key");
  }
  return frame.pendingKey;
}
