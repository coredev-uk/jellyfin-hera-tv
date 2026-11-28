// A small CSS reader and writer for the legacy build's own transforms: stylesheets in, a tree of
// comments, declarations, style rules and at-rules out, and back to text. It is not a validator;
// it reads what lightningcss writes (and the hand-written fixtures of the tests), keeping every
// value as the text it was so nothing is reinterpreted on the way through.

/** Where the statement that starts at `from` ends: the index of its `;`, `{` or `}` outside strings, comments and brackets. */
const statementEnd = (text, from) => {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === '"' || c === "'") i = stringEnd(text, i);
    else if (c === "/" && text[i + 1] === "*") i = commentEnd(text, i) - 1;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ";" || c === "{" || c === "}")) return i;
  }
  return text.length;
};

const stringEnd = (text, open) => {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return text.length;
};

const commentEnd = (text, open) => {
  const close = text.indexOf("*/", open + 2);
  return close < 0 ? text.length : close + 2;
};

/** The index of the `}` that closes the block opened at `open`. */
const blockEnd = (text, open) => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === '"' || c === "'") i = stringEnd(text, i);
    else if (c === "/" && text[i + 1] === "*") i = commentEnd(text, i) - 1;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return text.length;
};

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").trim();

const declaration = (text) => {
  const colon = text.indexOf(":");
  if (colon < 0) return null;
  const prop = text.slice(0, colon).trim();
  let value = text.slice(colon + 1).trim();
  let important = false;
  const bang = /\s*!\s*important\s*$/i.exec(value);
  if (bang) {
    important = true;
    value = value.slice(0, bang.index);
  }
  return { type: "decl", prop, value, important };
};

/** @returns {Array<object>} comments, declarations, rules (`{ selector, nodes }`) and at-rules (`{ name, prelude, nodes | null }`). */
export const parse = (text) => {
  const nodes = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i]) || text[i] === ";") {
      i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = commentEnd(text, i);
      nodes.push({ type: "comment", text: text.slice(i, end) });
      i = end;
      continue;
    }
    if (text[i] === "}") {
      i++;
      continue;
    }
    const end = statementEnd(text, i);
    const head = stripComments(text.slice(i, end));
    if (text[end] === "{") {
      const close = blockEnd(text, end);
      const inner = parse(text.slice(end + 1, close));
      if (head.startsWith("@")) {
        const match = /^@([\w-]+)\s*([\s\S]*)$/.exec(head);
        nodes.push({ type: "atrule", name: match[1].toLowerCase(), prelude: match[2].trim(), nodes: inner });
      } else {
        nodes.push({ type: "rule", selector: head, nodes: inner });
      }
      i = close + 1;
      continue;
    }
    if (head.startsWith("@")) {
      const match = /^@([\w-]+)\s*([\s\S]*)$/.exec(head);
      nodes.push({ type: "atrule", name: match[1].toLowerCase(), prelude: match[2].trim(), nodes: null });
    } else if (head) {
      const decl = declaration(head);
      if (decl) nodes.push(decl);
    }
    i = end + 1;
  }
  return nodes;
};

const declText = (decl) => `${decl.prop}: ${decl.value}${decl.important ? " !important" : ""};`;

/** The text of `nodes`, one declaration to a line and one blank line between rules of the same level. */
export const stringify = (nodes, depth = 0) => {
  const pad = "  ".repeat(depth);
  const out = [];
  for (const node of nodes) {
    if (node.type === "comment") out.push(`${pad}${node.text}`);
    else if (node.type === "decl") out.push(`${pad}${declText(node)}`);
    else {
      const head = node.type === "rule" ? splitTop(node.selector).join(`,\n${pad}`) : `@${node.name}${node.prelude ? ` ${node.prelude}` : ""}`;
      if (node.nodes === null) out.push(`${pad}${head};`);
      else if (node.nodes.length === 0) out.push(`${pad}${head} {\n${pad}}`);
      else out.push(`${pad}${head} {\n${stringify(node.nodes, depth + 1)}\n${pad}}`);
    }
  }
  // Rules and at-rules are told apart by a blank line; declarations and comments stay together.
  const blocks = nodes.map((node) => node.type === "rule" || node.type === "atrule");
  return out.reduce((text, chunk, index) => (index === 0 ? chunk : `${text}${blocks[index] || blocks[index - 1] ? "\n\n" : "\n"}${chunk}`), "");
};

/** Calls `visit(rule, atrules)` for every style rule, in order, inside the at-rules that group them (not keyframes or font faces). */
export const eachRule = (nodes, visit, atrules = []) => {
  for (const node of nodes) {
    if (node.type === "rule") visit(node, atrules);
    else if (node.type === "atrule" && node.nodes && ["media", "supports", "layer", "container", "document", "scope"].includes(node.name)) {
      eachRule(node.nodes, visit, [...atrules, node]);
    }
  }
};

// ---------- selectors ------------------------------------------------------------------------

/** Splits `text` at the top-level occurrences of `separator` (outside brackets, parentheses and strings). */
export const splitTop = (text, separator = ",") => {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === '"' || c === "'") i = stringEnd(text, i);
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && c === separator) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts.filter((part) => part !== "");
};

/** The index just past the bracket that closes the one opened at `open`. */
export const closing = (text, open) => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === '"' || c === "'") i = stringEnd(text, i);
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") {
      if (--depth === 0) return i + 1;
    }
  }
  return text.length;
};

/** A complex selector as its compounds and the combinators between them: `[{ combinator: "", compound }, { combinator: ">", compound }, ...]`. */
export const splitComplex = (selector) => {
  const parts = [];
  let combinator = "";
  let from = 0;
  let depth = 0;
  const flush = (to) => {
    const compound = selector.slice(from, to);
    if (compound) parts.push({ combinator, compound });
  };
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === "\\") i++;
    else if (c === '"' || c === "'") i = stringEnd(selector, i);
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && (/\s/.test(c) || c === ">" || c === "+" || c === "~")) {
      flush(i);
      let j = i;
      let found = "";
      while (j < selector.length && (/\s/.test(selector[j]) || ">+~".includes(selector[j]))) {
        if (">+~".includes(selector[j])) found = selector[j];
        j++;
      }
      combinator = found || " ";
      from = j;
      i = j - 1;
    }
  }
  flush(selector.length);
  return parts;
};

/** A compound selector as its simple selectors: `a.b:hover::before` -> `["a", ".b", ":hover", "::before"]`. */
export const splitCompound = (compound) => {
  const simples = [];
  let from = 0;
  for (let i = 0; i < compound.length; i++) {
    const c = compound[i];
    if (c === "\\") {
      i++;
    } else if (c === "[") {
      i = closing(compound, i) - 1;
    } else if (c === "(") {
      i = closing(compound, i) - 1;
    } else if ((c === "." || c === "#" || c === ":") && i > from) {
      simples.push(compound.slice(from, i));
      from = i;
      if (c === ":" && compound[i + 1] === ":") i++;
    } else if (c === ":" && compound[i + 1] === ":") {
      i++;
    }
  }
  if (from < compound.length) simples.push(compound.slice(from));
  return simples;
};

/** Where `:name(` opens in `selector` at the top level, as `{ start, open, close }` (close is just past the `)`), or null. */
export const findFunction = (selector, names, from = 0) => {
  const pattern = new RegExp(`:(${names.join("|")})\\(`, "g");
  pattern.lastIndex = from;
  let match;
  while ((match = pattern.exec(selector))) {
    // Skip a match inside an attribute selector or a string.
    const before = selector.slice(0, match.index);
    if ((before.match(/\[/g) ?? []).length === (before.match(/\]/g) ?? []).length && !insideString(before)) {
      const open = match.index + match[0].length - 1;
      return { start: match.index, name: match[1], open, close: closing(selector, open) };
    }
  }
  return null;
};

const insideString = (text) => ((text.match(/"/g) ?? []).length % 2 === 1) || ((text.match(/'/g) ?? []).length % 2 === 1);
