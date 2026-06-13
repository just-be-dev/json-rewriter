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

interface ValueHandlerGroups {
  object: HandlerRegistration[];
  array: HandlerRegistration[];
  string: HandlerRegistration[];
  number: HandlerRegistration[];
  boolean: HandlerRegistration[];
  null: HandlerRegistration[];
}

type ObjectState = "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
type ArrayState = "valueOrEnd" | "value" | "commaOrEnd";

interface ObjectFrame {
  type: "object";
  // Number of path segments from the root to this container. Member values live
  // at depth `len + 1`, with their final segment written to pathBuf[len].
  len: number;
  state: ObjectState;
  first: boolean;
  pendingOutputKeyJSON?: string;
  appendEntries: ObjectEntry[];
}

interface ArrayFrame {
  type: "array";
  len: number;
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
  private readonly valueHandlers: ValueHandlerGroups = createValueHandlerGroups();

  on(selector: string, handler: JSONHandler): this {
    const registration = { selector: compileSelector(selector), handler };
    this.handlers.push(registration);
    if (handler.key) {
      this.keyHandlers.push(registration);
    }
    addValueHandlerRegistration(this.valueHandlers, registration);
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
    let processToken: ((token: JSONToken) => void) | undefined;

    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        start: (controller) => {
          output = new BufferedOutput((chunk) => controller.enqueue(chunk));
          // The processor toggles tokenizer.preserveTokenValues directly when it
          // enters/leaves a skipped subtree, so the hot per-token loop stays a
          // single call with no extra branch or property write.
          processor = new StreamingProcessor(this.keyHandlers, this.valueHandlers, (chunk) => output?.write(chunk), (preserve) => {
            tokenizer.preserveTokenValues = preserve;
          });
          processToken = (token) => processor?.process(token);
        },
        transform(chunk) {
          const text = decoder.decode(chunk, { stream: true });
          tokenizer.feedTokens(text, false, processToken!);
          output?.flushReady();
        },
        flush() {
          const tail = decoder.decode();
          tokenizer.feedTokens(tail, true, processToken!);
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
  // Single reused buffer holding the path to the value currently being processed.
  // Selectors match against (pathBuf, length); we only snapshot a real array when
  // a handler actually matches, so the common no-match case allocates nothing.
  private readonly pathBuf: PathSegment[] = [];
  private rootState: "value" | "done" = "value";
  private skipValidator: SkipValidator | undefined;
  private readonly trackPaths: boolean;

  constructor(
    private readonly keyHandlers: readonly HandlerRegistration[],
    private readonly valueHandlers: ValueHandlerGroups,
    private readonly emit: (chunk: string) => void,
    private readonly setPreserveValues: (preserve: boolean) => void,
  ) {
    this.trackPaths = keyHandlers.length > 0 || hasValueHandlers(valueHandlers);
  }

  process(token: JSONToken): void {
    if (this.skipValidator) {
      if (this.skipValidator.process(token)) {
        this.skipValidator = undefined;
        // Skipped subtree fully consumed; resume preserving token values.
        this.setPreserveValues(true);
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

  private beginSkip(type: "object" | "array"): void {
    this.skipValidator = new SkipValidator(type);
    // No need to materialize values for content we are about to discard.
    this.setPreserveValues(false);
  }

  private processRootToken(token: JSONToken): void {
    if (this.rootState === "done") {
      throw new SyntaxError("Unexpected token after root JSON value");
    }

    if (!isValueToken(token)) {
      throw new SyntaxError("Expected root JSON value");
    }

    this.processValueToken(token, 0);
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
      let outputKeyJSON = token.output;
      if (this.trackPaths) {
        // The member value lives at depth frame.len + 1 with this key as its
        // final segment. Writing it now also leaves it in place for the value.
        const valueLen = frame.len + 1;
        this.pathBuf[frame.len] = token.value;
        if (this.keyHandlers.length > 0 && this.hasMatchingKeyHandler(valueLen)) {
          const key = new KeyNode(this.snapshotPath(valueLen), token.value);
          this.applyKeyHandlers(valueLen, key);
          outputKeyJSON = key.name === token.value ? token.output : JSON.stringify(key.name);
        }
      }
      frame.pendingOutputKeyJSON = outputKeyJSON;
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
      this.processValueToken(token, frame.len + 1);
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
      if (this.trackPaths) {
        this.pathBuf[frame.len] = frame.index;
      }
      this.processValueToken(token, frame.len + 1);
      return;
    }

    if (frame.state === "value") {
      if (!isValueToken(token)) {
        throw new SyntaxError("Expected array value");
      }
      if (this.trackPaths) {
        this.pathBuf[frame.len] = frame.index;
      }
      this.processValueToken(token, frame.len + 1);
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

  private processValueToken(token: JSONToken, len: number): void {
    if (token.type === "startObject") {
      const handlers = this.valueHandlers.object;
      if (!this.hasMatchingValueHandler(len, handlers)) {
        this.acceptValueStart(false);
        this.emit("{");
        this.stack.push({
          type: "object",
          len,
          state: "keyOrEnd",
          first: true,
          appendEntries: [],
        });
        return;
      }

      const node = new ContainerNode(this.snapshotPath(len)) as JSONObjectNodeImpl;
      this.applyValueHandlers(len, node, "object", handlers);
      this.acceptValueStart(node.removed);
      if (node.replacement !== undefined) {
        this.emit(node.replacement);
        this.beginSkip("object");
        return;
      }
      if (node.removed) {
        this.emitRootNullIfNeeded(len);
        this.beginSkip("object");
        return;
      }

      this.emit("{");
      const frame: ObjectFrame = {
        type: "object",
        len,
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
      const handlers = this.valueHandlers.array;
      if (!this.hasMatchingValueHandler(len, handlers)) {
        this.acceptValueStart(false);
        this.emit("[");
        this.stack.push({
          type: "array",
          len,
          state: "valueOrEnd",
          first: true,
          index: 0,
          appendItems: [],
        });
        return;
      }

      const node = new ContainerNode(this.snapshotPath(len)) as JSONArrayNodeImpl;
      this.applyValueHandlers(len, node, "array", handlers);
      this.acceptValueStart(node.removed);
      if (node.replacement !== undefined) {
        this.emit(node.replacement);
        this.beginSkip("array");
        return;
      }
      if (node.removed) {
        this.emitRootNullIfNeeded(len);
        this.beginSkip("array");
        return;
      }

      this.emit("[");
      const frame: ArrayFrame = {
        type: "array",
        len,
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

    const kind = scalarKind(token);
    const handlers = this.valueHandlers[kind];
    if (!this.hasMatchingValueHandler(len, handlers)) {
      this.acceptValueStart(false);
      this.emit(tokenToJSON(token));
      return;
    }

    const scalar = createScalarNode(token, this.snapshotPath(len));
    this.applyValueHandlers(len, scalar, kind, handlers);
    this.acceptValueStart(scalar.removed);
    if (scalar.replacement !== undefined) {
      this.emit(scalar.replacement);
      return;
    }
    if (scalar.removed) {
      this.emitRootNullIfNeeded(len);
      return;
    }
    this.emit(tokenToJSON(token));
  }

  private snapshotPath(len: number): PathSegment[] {
    return this.pathBuf.slice(0, len);
  }

  private acceptValueStart(removed: boolean): void {
    const parent = this.currentFrame();
    if (!parent) {
      this.rootState = "done";
      return;
    }

    if (parent.type === "object") {
      const keyJSON = parent.pendingOutputKeyJSON;
      if (keyJSON === undefined) {
        throw new SyntaxError("Missing object key");
      }
      if (!removed) {
        if (!parent.first) {
          this.emit(",");
        }
        this.emit(`${keyJSON}:`);
        parent.first = false;
      }
      parent.pendingOutputKeyJSON = undefined;
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

  private applyKeyHandlers(len: number, node: KeyNode): void {
    for (const registration of this.keyHandlers) {
      if (registration.selector.matches(this.pathBuf, len)) {
        registration.handler.key?.(node);
      }
    }
  }

  private hasMatchingKeyHandler(len: number): boolean {
    for (const registration of this.keyHandlers) {
      if (registration.selector.matches(this.pathBuf, len)) {
        return true;
      }
    }
    return false;
  }

  private hasMatchingValueHandler(len: number, handlers: readonly HandlerRegistration[]): boolean {
    for (const registration of handlers) {
      if (registration.selector.matches(this.pathBuf, len)) {
        return true;
      }
    }
    return false;
  }

  private applyValueHandlers(len: number, node: MutableNode | ContainerNode, kind: ValueKind, handlers: readonly HandlerRegistration[]): void {
    for (const registration of handlers) {
      if (!registration.selector.matches(this.pathBuf, len)) {
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

  private emitRootNullIfNeeded(len: number): void {
    if (len === 0) {
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

function createValueHandlerGroups(): ValueHandlerGroups {
  return {
    object: [],
    array: [],
    string: [],
    number: [],
    boolean: [],
    null: [],
  };
}

function addValueHandlerRegistration(groups: ValueHandlerGroups, registration: HandlerRegistration): void {
  const handler = registration.handler;
  if (handler.value) {
    groups.object.push(registration);
    groups.array.push(registration);
    groups.string.push(registration);
    groups.number.push(registration);
    groups.boolean.push(registration);
    groups.null.push(registration);
    return;
  }

  if (handler.object) {
    groups.object.push(registration);
  }
  if (handler.array) {
    groups.array.push(registration);
  }
  if (handler.string) {
    groups.string.push(registration);
  }
  if (handler.number) {
    groups.number.push(registration);
  }
  if (handler.boolean) {
    groups.boolean.push(registration);
  }
  if (handler.null) {
    groups.null.push(registration);
  }
}

function hasValueHandlers(groups: ValueHandlerGroups): boolean {
  return (
    groups.object.length > 0 ||
    groups.array.length > 0 ||
    groups.string.length > 0 ||
    groups.number.length > 0 ||
    groups.boolean.length > 0 ||
    groups.null.length > 0
  );
}

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
