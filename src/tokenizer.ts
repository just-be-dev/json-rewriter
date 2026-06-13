export type JSONToken =
  | { type: "startObject" }
  | { type: "endObject" }
  | { type: "startArray" }
  | { type: "endArray" }
  | { type: "colon" }
  | { type: "comma" }
  | { type: "string"; value: string; output: string }
  | { type: "number"; raw: string; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "null" };

export type JSONTokenCallback = (token: JSONToken, start: number, end: number, buffer: string) => void;
export type JSONWhitespaceCallback = (start: number, end: number, buffer: string) => void;
export type JSONFlushCallback = (buffer: string, end: number) => void;

const START_OBJECT_TOKEN: JSONToken = { type: "startObject" };
const END_OBJECT_TOKEN: JSONToken = { type: "endObject" };
const START_ARRAY_TOKEN: JSONToken = { type: "startArray" };
const END_ARRAY_TOKEN: JSONToken = { type: "endArray" };
const COLON_TOKEN: JSONToken = { type: "colon" };
const COMMA_TOKEN: JSONToken = { type: "comma" };
const TRUE_TOKEN: JSONToken = { type: "boolean", value: true };
const FALSE_TOKEN: JSONToken = { type: "boolean", value: false };
const NULL_TOKEN: JSONToken = { type: "null" };
const SKIPPED_STRING_TOKEN: JSONToken = { type: "string", value: "", output: '""' };
const SKIPPED_NUMBER_TOKEN: JSONToken = { type: "number", raw: "0", value: 0 };
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

type MutableStringToken = { type: "string"; value: string; output: string };
type MutableNumberToken = { type: "number"; raw: string; value: number };

export class JSONTokenizer {
  preserveTokenValues = true;

  private buffer = "";
  private position = 0;

  // Reused across tokens to avoid allocating an object per scalar. The processor
  // consumes each token synchronously (copying values it needs) before the next
  // token is read, so mutating a shared instance is safe in the streaming path.
  private readonly stringToken: MutableStringToken = { type: "string", value: "", output: "" };
  private readonly numberToken: MutableNumberToken = { type: "number", raw: "", value: 0 };

  feed(chunk: string, final = false): JSONToken[] {
    const tokens: JSONToken[] = [];
    this.feedTokens(chunk, final, (token) => {
      // feed() materializes tokens into an array, so the reused scalar instances
      // must be copied to avoid every entry aliasing the same mutated object.
      tokens.push(token.type === "string" || token.type === "number" ? { ...token } : token);
    });
    return tokens;
  }

  feedTokens(
    chunk: string,
    final = false,
    onToken: JSONTokenCallback,
    onWhitespace?: JSONWhitespaceCallback,
    onFlush?: JSONFlushCallback,
  ): void {
    this.buffer += chunk;

    while (true) {
      const whitespaceStart = this.position;
      this.skipWhitespace();
      if (this.position > whitespaceStart) {
        onWhitespace?.(whitespaceStart, this.position, this.buffer);
      }
      if (this.position >= this.buffer.length) {
        break;
      }

      const start = this.position;
      const token = this.readToken(final, this.preserveTokenValues);
      if (!token) {
        break;
      }
      onToken(token, start, this.position, this.buffer);
    }

    if (this.position > 0) {
      onFlush?.(this.buffer, this.position);
      this.buffer = this.buffer.slice(this.position);
      this.position = 0;
    }

    if (final) {
      this.skipWhitespace();
      if (this.position < this.buffer.length) {
        throw new SyntaxError(`Invalid JSON near: ${this.buffer.slice(this.position, this.position + 20)}`);
      }
      this.buffer = "";
      this.position = 0;
    }
  }

  private readToken(final: boolean, preserveValue: boolean): JSONToken | undefined {
    // charCodeAt avoids allocating a one-character string per token, which
    // matters because this runs once for every one of millions of tokens.
    const code = this.buffer.charCodeAt(this.position);

    switch (code) {
      case CHAR_OPEN_BRACE:
        this.position += 1;
        return START_OBJECT_TOKEN;
      case CHAR_CLOSE_BRACE:
        this.position += 1;
        return END_OBJECT_TOKEN;
      case CHAR_OPEN_BRACKET:
        this.position += 1;
        return START_ARRAY_TOKEN;
      case CHAR_CLOSE_BRACKET:
        this.position += 1;
        return END_ARRAY_TOKEN;
      case CHAR_COLON:
        this.position += 1;
        return COLON_TOKEN;
      case CHAR_COMMA:
        this.position += 1;
        return COMMA_TOKEN;
      case CHAR_QUOTE:
        return this.readString(final, preserveValue);
      case CHAR_LOWER_T:
      case CHAR_LOWER_F:
      case CHAR_LOWER_N:
        return this.readLiteral(final);
    }

    if (code === CHAR_MINUS || (code >= CHAR_ZERO && code <= CHAR_NINE)) {
      return this.readNumber(final, preserveValue);
    }

    throw new SyntaxError(`Unexpected JSON character: ${this.buffer[this.position]}`);
  }

  private readString(final: boolean, preserveValue: boolean): JSONToken | undefined {
    const buffer = this.buffer;
    const length = buffer.length;
    const start = this.position;
    let index = start + 1;
    let hasEscape = false;

    while (index < length) {
      const code = buffer.charCodeAt(index);

      if (code === CHAR_QUOTE) {
        this.position = index + 1;
        if (!preserveValue) {
          return SKIPPED_STRING_TOKEN;
        }

        const token = this.stringToken;
        if (!hasEscape) {
          token.value = buffer.slice(start + 1, index);
          token.output = buffer.slice(start, index + 1);
          return token;
        }

        const value = JSON.parse(buffer.slice(start, index + 1)) as string;
        token.value = value;
        token.output = JSON.stringify(value);
        return token;
      }

      if (code === CHAR_BACKSLASH) {
        hasEscape = true;
        if (index + 1 >= length) {
          if (final) {
            throw new SyntaxError("Unterminated JSON string");
          }
          return undefined;
        }

        const escaped = buffer.charCodeAt(index + 1);
        if (escaped === CHAR_LOWER_U) {
          if (index + 5 >= length) {
            if (final) {
              throw new SyntaxError("Invalid Unicode escape in JSON string");
            }
            return undefined;
          }
          for (let cursor = index + 2; cursor <= index + 5; cursor += 1) {
            if (!isHexDigit(buffer.charCodeAt(cursor))) {
              throw new SyntaxError("Invalid Unicode escape in JSON string");
            }
          }
          index += 6;
          continue;
        }
        if (!isSimpleEscape(escaped)) {
          throw new SyntaxError("Invalid escape in JSON string");
        }
        index += 2;
        continue;
      }

      if (code < 0x20) {
        throw new SyntaxError("Unexpected control character in JSON string");
      }

      index += 1;
    }

    if (final) {
      throw new SyntaxError("Unterminated JSON string");
    }
    return undefined;
  }

  private readLiteral(final: boolean): JSONToken | undefined {
    if (this.matchesPartialLiteral("true", final)) {
      return undefined;
    }
    if (this.matchesPartialLiteral("false", final)) {
      return undefined;
    }
    if (this.matchesPartialLiteral("null", final)) {
      return undefined;
    }

    if (this.buffer.startsWith("true", this.position)) {
      this.position += 4;
      return TRUE_TOKEN;
    }
    if (this.buffer.startsWith("false", this.position)) {
      this.position += 5;
      return FALSE_TOKEN;
    }
    if (this.buffer.startsWith("null", this.position)) {
      this.position += 4;
      return NULL_TOKEN;
    }

    throw new SyntaxError(`Invalid JSON literal near: ${this.buffer.slice(this.position, this.position + 10)}`);
  }

  private matchesPartialLiteral(literal: string, final: boolean): boolean {
    const remaining = this.buffer.length - this.position;
    return !final && remaining < literal.length && literal.startsWith(this.buffer.slice(this.position));
  }

  private readNumber(final: boolean, preserveValue: boolean): JSONToken | undefined {
    const start = this.position;
    let index = start;
    const length = this.buffer.length;

    while (index < length && isNumberCharacter(this.buffer.charCodeAt(index))) {
      index += 1;
    }

    if (index === this.buffer.length && !final) {
      return undefined;
    }

    const raw = this.buffer.slice(start, index);
    if (!NUMBER_PATTERN.test(raw)) {
      throw new SyntaxError(`Invalid JSON number: ${raw}`);
    }

    this.position = index;
    if (!preserveValue) {
      return SKIPPED_NUMBER_TOKEN;
    }
    const token = this.numberToken;
    token.raw = raw;
    token.value = Number(raw);
    return token;
  }

  private skipWhitespace(): void {
    while (isJSONWhitespace(this.buffer.charCodeAt(this.position))) {
      this.position += 1;
    }
  }
}

const CHAR_OPEN_BRACE = 0x7b; // {
const CHAR_CLOSE_BRACE = 0x7d; // }
const CHAR_OPEN_BRACKET = 0x5b; // [
const CHAR_CLOSE_BRACKET = 0x5d; // ]
const CHAR_COLON = 0x3a; // :
const CHAR_COMMA = 0x2c; // ,
const CHAR_QUOTE = 0x22; // "
const CHAR_BACKSLASH = 0x5c; // \
const CHAR_MINUS = 0x2d; // -
const CHAR_PLUS = 0x2b; // +
const CHAR_DOT = 0x2e; // .
const CHAR_ZERO = 0x30; // 0
const CHAR_NINE = 0x39; // 9
const CHAR_LOWER_E = 0x65; // e
const CHAR_UPPER_E = 0x45; // E
const CHAR_LOWER_T = 0x74; // t
const CHAR_LOWER_F = 0x66; // f
const CHAR_LOWER_N = 0x6e; // n
const CHAR_LOWER_U = 0x75; // u
const CHAR_LOWER_B = 0x62; // b
const CHAR_LOWER_R = 0x72; // r
const CHAR_SLASH = 0x2f; // /

function isNumberCharacter(code: number): boolean {
  return (
    (code >= CHAR_ZERO && code <= CHAR_NINE) ||
    code === CHAR_MINUS ||
    code === CHAR_PLUS ||
    code === CHAR_DOT ||
    code === CHAR_LOWER_E ||
    code === CHAR_UPPER_E
  );
}

function isSimpleEscape(code: number): boolean {
  return (
    code === CHAR_QUOTE ||
    code === CHAR_BACKSLASH ||
    code === CHAR_SLASH ||
    code === CHAR_LOWER_B ||
    code === CHAR_LOWER_F ||
    code === CHAR_LOWER_N ||
    code === CHAR_LOWER_R ||
    code === CHAR_LOWER_T
  );
}

function isHexDigit(value: number): boolean {
  return (
    (value >= 0x30 && value <= 0x39) ||
    (value >= 0x41 && value <= 0x46) ||
    (value >= 0x61 && value <= 0x66)
  );
}

function isJSONWhitespace(value: number): boolean {
  return value === 0x20 || value === 0x0a || value === 0x0d || value === 0x09;
}
