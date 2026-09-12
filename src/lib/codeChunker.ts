import { createRequire } from "node:module";
import path from "node:path";
import Parser from "web-tree-sitter";

type Language = InstanceType<typeof Parser.Language>;
type Node = Parser.SyntaxNode;

const require = createRequire(import.meta.url);

export interface CodeChunk {
  filePath: string;
  symbolName: string;
  kind: "function" | "method" | "class" | "arrow";
  startLine: number;
  endLine: number;
  content: string;
}

/** Any single chunk's source text over this size is truncated before embedding — keeps a handful of
 *  giant generated/minified functions from blowing up the embedding request. */
const MAX_CHUNK_CHARS = 8_000;

type GrammarName = "typescript" | "tsx" | "javascript";

function grammarForExtension(ext: string): GrammarName | undefined {
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      return undefined;
  }
}

let initPromise: Promise<void> | undefined;
const languageCache = new Map<GrammarName, Promise<Language>>();

async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

async function loadLanguage(name: GrammarName): Promise<Language> {
  let cached = languageCache.get(name);
  if (!cached) {
    const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
    cached = Parser.Language.load(wasmPath);
    languageCache.set(name, cached);
  }
  return cached;
}

function textOf(node: Node): string {
  const text = node.text;
  return text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text;
}

function chunkFromNode(filePath: string, symbolName: string, kind: CodeChunk["kind"], node: Node): CodeChunk {
  return {
    filePath,
    symbolName,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    content: textOf(node),
  };
}

/** Unwraps `export`/`export default` so the wrapped declaration is what gets matched below. */
function unwrapExport(node: Node): Node {
  if (node.type !== "export_statement") return node;
  return node.childForFieldName("declaration") ?? node;
}

const FUNCTION_VALUE_TYPES = new Set(["arrow_function", "function_expression", "function"]);

/**
 * Chunks one file's top-level function/class declarations and class methods — deliberately not a
 * full recursive walk (nested/inner functions aren't split out on their own), matching "chunk by
 * function/class boundary" rather than every possible expression.
 */
function extractChunks(filePath: string, root: Node): CodeChunk[] {
  const chunks: CodeChunk[] = [];

  for (const rawChild of root.namedChildren) {
    if (!rawChild) continue;
    const child = unwrapExport(rawChild);

    if (child.type === "function_declaration") {
      const name = child.childForFieldName("name")?.text ?? "anonymous";
      chunks.push(chunkFromNode(filePath, name, "function", child));
      continue;
    }

    if (child.type === "class_declaration") {
      const className = child.childForFieldName("name")?.text ?? "AnonymousClass";
      const body = child.childForFieldName("body");
      for (const member of body?.namedChildren ?? []) {
        if (!member || member.type !== "method_definition") continue;
        const methodName = member.childForFieldName("name")?.text ?? "anonymous";
        chunks.push(chunkFromNode(filePath, `${className}.${methodName}`, "method", member));
      }
      continue;
    }

    if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
      for (const declarator of child.namedChildren) {
        if (!declarator || declarator.type !== "variable_declarator") continue;
        const value = declarator.childForFieldName("value");
        if (!value || !FUNCTION_VALUE_TYPES.has(value.type)) continue;
        const name = declarator.childForFieldName("name")?.text ?? "anonymous";
        chunks.push(chunkFromNode(filePath, name, "arrow", declarator));
      }
    }
  }

  return chunks;
}

/** Chunks one TS/JS source file by function/class boundary using tree-sitter (not fixed line counts).
 *  Returns an empty array for unsupported extensions or files that fail to parse. */
export async function chunkFile(filePath: string, source: string): Promise<CodeChunk[]> {
  const grammar = grammarForExtension(path.extname(filePath));
  if (!grammar) return [];

  await ensureInit();
  const language = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  try {
    const tree = parser.parse(source);
    if (!tree) return [];
    return extractChunks(filePath, tree.rootNode);
  } finally {
    parser.delete();
  }
}
