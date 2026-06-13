import type { PathSegment } from "./types";

type SelectorStep =
  | { type: "property"; name: string }
  | { type: "index"; index: number }
  | { type: "wildcard" }
  | { type: "recursiveProperty"; name: string };

export interface CompiledSelector {
  readonly source: string;
  // Matches against the first `length` segments of `path`. `path` is a shared,
  // reused buffer in the hot path, so entries beyond `length` must be ignored.
  matches(path: readonly PathSegment[], length: number): boolean;
}

export function compileSelector(source: string): CompiledSelector {
  const steps = parseSelector(source);

  if (steps.length === 0) {
    return {
      source,
      matches(_path, length) {
        return length === 0;
      },
    };
  }

  if (steps.length === 1 && steps[0]?.type === "recursiveProperty") {
    const name = steps[0].name;
    return {
      source,
      matches(path, length) {
        return length > 0 && path[length - 1] === name;
      },
    };
  }

  if (!steps.some((step) => step.type === "recursiveProperty")) {
    return {
      source,
      matches(path, length) {
        return matchExactSteps(steps, path, length);
      },
    };
  }

  return {
    source,
    matches(path, length) {
      return matchSteps(steps, path, length, 0, 0);
    },
  };
}

function matchExactSteps(steps: readonly SelectorStep[], path: readonly PathSegment[], length: number): boolean {
  if (steps.length !== length) {
    return false;
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const segment = path[index];

    if (!step) {
      return false;
    }
    if (step.type === "wildcard") {
      continue;
    }
    if (step.type === "property") {
      if (segment !== step.name) {
        return false;
      }
      continue;
    }
    if (step.type === "index" && segment !== step.index) {
      return false;
    }
    if (step.type === "recursiveProperty") {
      return false;
    }
  }

  return true;
}

function parseSelector(source: string): SelectorStep[] {
  if (source === "") {
    throw new SyntaxError("Selector must not be empty");
  }

  let index = 0;
  if (source[index] !== "$") {
    throw new SyntaxError(`Selector must start with $: ${source}`);
  }
  index += 1;

  const steps: SelectorStep[] = [];
  while (index < source.length) {
    const char = source[index];

    if (char === ".") {
      if (source[index + 1] === ".") {
        index += 2;
        const name = readIdentifier(source, index);
        if (!name.value) {
          throw new SyntaxError(`Expected property after .. in selector: ${source}`);
        }
        steps.push({ type: "recursiveProperty", name: name.value });
        index = name.next;
        continue;
      }

      index += 1;
      if (source[index] === "*") {
        steps.push({ type: "wildcard" });
        index += 1;
        continue;
      }

      const name = readIdentifier(source, index);
      if (!name.value) {
        throw new SyntaxError(`Expected property after . in selector: ${source}`);
      }
      steps.push({ type: "property", name: name.value });
      index = name.next;
      continue;
    }

    if (char === "[") {
      if (source[index + 1] === "*") {
        if (source[index + 2] !== "]") {
          throw new SyntaxError(`Expected ] after * in selector: ${source}`);
        }
        steps.push({ type: "wildcard" });
        index += 3;
        continue;
      }

      if (source[index + 1] === '"' || source[index + 1] === "'") {
        const quote = source[index + 1];
        let cursor = index + 2;
        let raw = "";
        while (cursor < source.length) {
          const current = source[cursor];
          if (current === "\\") {
            if (cursor + 1 >= source.length) {
              throw new SyntaxError(`Unterminated escape in selector: ${source}`);
            }
            raw += current + source[cursor + 1];
            cursor += 2;
            continue;
          }
          if (current === quote) {
            break;
          }
          raw += current;
          cursor += 1;
        }
        if (source[cursor] !== quote || source[cursor + 1] !== "]") {
          throw new SyntaxError(`Unterminated quoted property in selector: ${source}`);
        }
        const jsonQuote = quote === "'" ? '"' : quote;
        const jsonRaw = quote === "'" ? raw.replaceAll('"', '\\"') : raw;
        steps.push({ type: "property", name: JSON.parse(`${jsonQuote}${jsonRaw}${jsonQuote}`) as string });
        index = cursor + 2;
        continue;
      }

      const end = source.indexOf("]", index + 1);
      if (end === -1) {
        throw new SyntaxError(`Unterminated index in selector: ${source}`);
      }
      const rawIndex = source.slice(index + 1, end);
      if (!/^(?:0|[1-9]\d*)$/.test(rawIndex)) {
        throw new SyntaxError(`Unsupported array index in selector: ${source}`);
      }
      steps.push({ type: "index", index: Number(rawIndex) });
      index = end + 1;
      continue;
    }

    throw new SyntaxError(`Unexpected selector character ${char}: ${source}`);
  }

  return steps;
}

function readIdentifier(source: string, start: number): { value: string; next: number } {
  let index = start;
  while (index < source.length && /[A-Za-z0-9_$-]/.test(source[index] ?? "")) {
    index += 1;
  }
  return { value: source.slice(start, index), next: index };
}

function matchSteps(
  steps: readonly SelectorStep[],
  path: readonly PathSegment[],
  length: number,
  stepIndex: number,
  pathIndex: number,
): boolean {
  if (stepIndex === steps.length) {
    return pathIndex === length;
  }

  const step = steps[stepIndex];
  if (!step) {
    return false;
  }

  if (step.type === "recursiveProperty") {
    for (let i = pathIndex; i < length; i += 1) {
      if (path[i] === step.name && matchSteps(steps, path, length, stepIndex + 1, i + 1)) {
        return true;
      }
    }
    return false;
  }

  if (pathIndex >= length) {
    return false;
  }
  const segment = path[pathIndex];

  if (step.type === "wildcard") {
    return matchSteps(steps, path, length, stepIndex + 1, pathIndex + 1);
  }

  if (step.type === "property") {
    return segment === step.name && matchSteps(steps, path, length, stepIndex + 1, pathIndex + 1);
  }

  return segment === step.index && matchSteps(steps, path, length, stepIndex + 1, pathIndex + 1);
}
