export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

export type PathSegment = string | number;

export interface JSONNode<T = JSONValue> {
  readonly path: readonly PathSegment[];
  readonly value: T | undefined;
  readonly removed: boolean;
  replace(value: JSONValue): this;
  remove(): this;
}

export interface JSONScalarNode<T extends JSONValue = JSONValue> extends JSONNode<T> {
  readonly value: T;
}

export interface JSONObjectNode extends JSONNode<undefined> {
  prepend(key: string, value: JSONValue): this;
  append(key: string, value: JSONValue): this;
}

export interface JSONArrayNode extends JSONNode<undefined> {
  prepend(value: JSONValue): this;
  append(value: JSONValue): this;
}

export interface JSONKeyNode {
  readonly path: readonly PathSegment[];
  readonly name: string;
  rename(name: string): this;
}

export interface JSONHandler {
  value?(node: JSONNode): void;
  object?(node: JSONObjectNode): void;
  array?(node: JSONArrayNode): void;
  string?(node: JSONScalarNode<string>): void;
  number?(node: JSONScalarNode<number>): void;
  boolean?(node: JSONScalarNode<boolean>): void;
  null?(node: JSONScalarNode<null>): void;
  key?(node: JSONKeyNode): void;
}
