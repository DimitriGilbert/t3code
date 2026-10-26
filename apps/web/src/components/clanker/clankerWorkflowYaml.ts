/**
 * Writes a workflow object onto the document it came from, mutating nodes in
 * place so comments on everything the form did not touch survive the write.
 */
import {
  Pair,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  visit,
} from "yaml";
import type { Document, Node, YAMLMap, YAMLSeq } from "yaml";

const STRINGIFY_OPTIONS = { lineWidth: 0 } as const;

export function writeClankerWorkflowYaml(
  object: Record<string, unknown>,
  baseText: string,
): string {
  if (baseText.trim() === "") return stringify(object, STRINGIFY_OPTIONS);
  const document = parseDocument(baseText);
  // A document with aliases or parse errors is re-stringified instead, losing
  // every comment. Mutation still drops comments on removed keys, and on the
  // inside of a value whose kind changed.
  if (document.errors.length > 0 || !isMap(document.contents) || hasAlias(document)) {
    return stringify(object, STRINGIFY_OPTIONS);
  }
  mergeMap(document, document.contents, object);
  return document.toString(STRINGIFY_OPTIONS);
}

/** Aliases and merge keys cannot be rewritten in place without losing meaning. */
function hasAlias(document: Document): boolean {
  let found = false;
  visit(document, {
    Node: (_key, node) => {
      if (!isAlias(node)) return undefined;
      found = true;
      return visit.BREAK;
    },
  });
  return found;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyText(key: unknown): string | null {
  return isScalar(key) && typeof key.value === "string" ? key.value : null;
}

function nodeValue(node: unknown): unknown {
  return isNode(node) ? node.toJSON() : node;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, at) => deepEqual(entry, right[at]));
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function mergeMap(
  document: Document,
  map: YAMLMap<unknown, unknown>,
  next: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(next)) {
    const pair = map.items.find((item) => keyText(item.key) === key);
    if (pair === undefined) {
      map.items.push(new Pair(document.createNode(key), document.createNode(value)));
      continue;
    }
    pair.value = mergeNode(document, pair.value, value);
  }
  map.items = map.items.filter((item) => {
    const key = keyText(item.key);
    return key !== null && Object.hasOwn(next, key);
  });
}

function mergeNode(document: Document, node: unknown, value: unknown): unknown {
  if (isMap(node) && isPlainRecord(value)) {
    mergeMap(document, node, value);
    return node;
  }
  if (isSeq(node) && Array.isArray(value)) {
    mergeSeq(document, node, value);
    return node;
  }
  if (deepEqual(nodeValue(node), value)) return node;
  const created: Node = document.createNode(value);
  if (isNode(node)) {
    if (node.comment !== undefined) created.comment = node.comment;
    if (node.commentBefore !== undefined) created.commentBefore = node.commentBefore;
    if (node.spaceBefore !== undefined) created.spaceBefore = node.spaceBefore;
  }
  return created;
}

function mergeSeq(document: Document, seq: YAMLSeq<unknown>, values: ReadonlyArray<unknown>): void {
  const items = seq.items;
  const order = itemPermutation(items, values);
  if (order !== null) {
    if (order.some((from, to) => from !== to)) {
      hoistLeadingComment(seq);
      seq.items = order.map((from) => items[from]);
    }
    return;
  }
  seq.items = values.map((value, index) =>
    index < items.length ? mergeNode(document, items[index], value) : document.createNode(value),
  );
}

/**
 * When the new list is a permutation of the old one — a step moved up or down —
 * the existing nodes are reordered so their comments travel with them.
 */
function itemPermutation(
  items: ReadonlyArray<unknown>,
  values: ReadonlyArray<unknown>,
): Array<number> | null {
  if (items.length !== values.length) return null;
  const taken = new Set<number>();
  const order: Array<number> = [];
  for (const value of values) {
    const index = items.findIndex(
      (item, at) => !taken.has(at) && deepEqual(nodeValue(item), value),
    );
    if (index === -1) return null;
    taken.add(index);
    order.push(index);
  }
  return order;
}

/** A comment above the first item parses onto the list, so move it down first. */
function hoistLeadingComment(seq: YAMLSeq<unknown>): void {
  const comment = seq.commentBefore;
  const first = seq.items[0];
  if (comment === undefined || comment === null || !isNode(first)) return;
  if (first.commentBefore !== undefined && first.commentBefore !== null) return;
  first.commentBefore = comment;
  seq.commentBefore = null;
}
