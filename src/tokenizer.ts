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

export class JSONTokenizer {
  private buffer = "";
  private position = 0;

  feed(chunk: string, final = false): JSONToken[] {
    const tokens: JSONToken[] = [];
    this.feedTokens(chunk, final, (token) => {
      tokens.push(token);
    });
    return tokens;
  }

  feedTokens(chunk: string, final = false, onToken: (token: JSONToken) => void): void {
    this.buffer += chunk;

    while (true) {
      this.skipWhitespace();
      if (this.position >= this.buffer.length) {
        break;
      }

      const token = this.readToken(final);
      if (!token) {
        break;
      }
      onToken(token);
    }

    if (this.position > 0) {
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

  private readToken(final: boolean): JSONToken | undefined {
    const char = this.buffer[this.position];

    if (char === "{") {
      this.position += 1;
      return { type: "startObject" };
    }
    if (char === "}") {
      this.position += 1;
      return { type: "endObject" };
    }
    if (char === "[") {
      this.position += 1;
      return { type: "startArray" };
    }
    if (char === "]") {
      this.position += 1;
      return { type: "endArray" };
    }
    if (char === ":") {
      this.position += 1;
      return { type: "colon" };
    }
    if (char === ",") {
      this.position += 1;
      return { type: "comma" };
    }
    if (char === '"') {
      return this.readString(final);
    }
    if (char === "t" || char === "f" || char === "n") {
      return this.readLiteral(final);
    }
    if (char === "-" || isDigit(char)) {
      return this.readNumber(final);
    }

    throw new SyntaxError(`Unexpected JSON character: ${char}`);
  }

  private readString(final: boolean): JSONToken | undefined {
    const start = this.position;
    let index = start + 1;
    let hasEscape = false;

    while (index < this.buffer.length) {
      const char = this.buffer[index];
      if (char === '"') {
        const raw = this.buffer.slice(start, index + 1);
        this.position = index + 1;
        if (!hasEscape) {
          return { type: "string", value: this.buffer.slice(start + 1, index), output: raw };
        }

        const value = JSON.parse(raw) as string;
        return { type: "string", value, output: JSON.stringify(value) };
      }

      if (char === "\\") {
        hasEscape = true;
        index += 2;
        continue;
      }

      if ((char?.charCodeAt(0) ?? 0) < 0x20) {
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
      return { type: "boolean", value: true };
    }
    if (this.buffer.startsWith("false", this.position)) {
      this.position += 5;
      return { type: "boolean", value: false };
    }
    if (this.buffer.startsWith("null", this.position)) {
      this.position += 4;
      return { type: "null" };
    }

    throw new SyntaxError(`Invalid JSON literal near: ${this.buffer.slice(this.position, this.position + 10)}`);
  }

  private matchesPartialLiteral(literal: string, final: boolean): boolean {
    const remaining = this.buffer.length - this.position;
    return !final && remaining < literal.length && literal.startsWith(this.buffer.slice(this.position));
  }

  private readNumber(final: boolean): JSONToken | undefined {
    const start = this.position;
    let index = start;

    while (index < this.buffer.length && isNumberCharacter(this.buffer[index])) {
      index += 1;
    }

    if (index === this.buffer.length && !final) {
      return undefined;
    }

    const raw = this.buffer.slice(start, index);
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
      throw new SyntaxError(`Invalid JSON number: ${raw}`);
    }

    this.position = index;
    return { type: "number", raw, value: Number(raw) };
  }

  private skipWhitespace(): void {
    while (isJSONWhitespace(this.buffer.charCodeAt(this.position))) {
      this.position += 1;
    }
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isNumberCharacter(value: string | undefined): boolean {
  return (
    value === "-" ||
    value === "+" ||
    value === "." ||
    value === "e" ||
    value === "E" ||
    isDigit(value)
  );
}

function isJSONWhitespace(value: number): boolean {
  return value === 0x20 || value === 0x0a || value === 0x0d || value === 0x09;
}
