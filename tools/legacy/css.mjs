// Hera's stylesheets for Chromium 53 to 87 (Tizen 5's browser, webOS 4's, a TV's Chromium before
// 88). lightningcss does what it can safely (nesting, vendor prefixes, media-query ranges, colours
// it can resolve); what it leaves, and what a TV needs beyond it, is done here, in the same
// cascade order. Every transform counts what it did and what it had to leave, for the report.
import { Features, transform } from "lightningcss";
import { formatColor, fade, parseColor } from "./css-color.mjs";
import { hasMath, reduceMath } from "./css-math.mjs";
import { eachRule, parse, splitTop, stringify } from "./css-model.mjs";
import { lowerSelector, pseudoElementOf, subjectOf } from "./css-selectors.mjs";

/** lightningcss's lowerings that would do harm here: clamp() is turned into max(min()), which these engines read no better; :is() and :not() are done by css-selectors.mjs, which writes what Chromium 53 can read; logical properties become `:dir()` pairs, which Chromium reads only from 120. */
const KEEP = Features.ClampFunction | Features.IsSelector | Features.NotSelectorList | Features.LogicalProperties;

/** Elements that draw their own content, so a ::before spacer in them is never drawn. */
const REPLACED = new Set(["img", "video", "canvas", "iframe", "svg", "input", "select", "textarea", "object", "embed", "picture"]);

/** Tokens whose glass look needs backdrop-filter, which these engines lack: made near-opaque so text over artwork stays readable. */
const GLASS_TOKENS = new Set(["--hera-glass", "--hera-glass-hover"]);
const GLASS_ALPHA = 0.92;
const BLURRED_BACKGROUND_ALPHA = 0.88;

const GROUPING = new Set(["media", "supports", "layer", "container", "document", "scope"]);

export class Report {
  constructor() {
    this.counts = new Map();
    this.notes = new Map();
    this.flexContainers = new Set();
  }

  count(name, n = 1) {
    this.counts.set(name, (this.counts.get(name) ?? 0) + n);
  }

  /** Something left as it was, or dropped, with where it was. */
  note(name, detail) {
    if (!this.notes.has(name)) this.notes.set(name, []);
    this.notes.get(name).push(detail);
  }
}

const spaces = (text) => {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if ((c === undefined || /\s/.test(c)) && depth === 0) {
      if (i > from) parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  return parts;
};

const decl = (prop, value, important = false) => ({ type: "decl", prop, value, important });

// ---------- the index: what the whole bundle says about an element, for the rewrites that must know ----------

class Index {
  constructor() {
    this.facts = new Map(); // subject -> [{ position, prop, value }]
    this.pseudo = new Set(); // subjects with a ::before or ::after rule somewhere
    this.position = 0;
  }

  add(rule) {
    const position = this.position++;
    for (const selector of splitTop(rule.selector)) {
      const subject = subjectOf(selector);
      const pseudo = pseudoElementOf(selector);
      if (pseudo === "before" || pseudo === "after") this.pseudo.add(`${subject}::${pseudo}`);
      if (pseudo) continue;
      for (const node of rule.nodes) {
        if (node.type === "decl") {
          if (!this.facts.has(subject)) this.facts.set(subject, []);
          this.facts.get(subject).push({ position, prop: node.prop, value: node.value.toLowerCase() });
        }
      }
    }
  }

  /** What `prop` is for `subject` where rule number `position` sits: the last say of any rule about it so far, else the first after. */
  value(subject, prop, position) {
    const says = (this.facts.get(subject) ?? []).filter((fact) => fact.prop === prop);
    const before = says.filter((fact) => fact.position <= position);
    return (before.length ? before[before.length - 1] : says[0])?.value ?? null;
  }

  has(subject, prop, test) {
    return (this.facts.get(subject) ?? []).some((fact) => fact.prop === prop && test(fact.value));
  }
}

const buildIndex = (trees) => {
  const index = new Index();
  for (const tree of trees) eachRule(tree.nodes, (rule) => index.add(rule));
  return index;
};

// ---------- selectors ----------

const lowerSelectors = (rule, context) => {
  const kept = [];
  for (const selector of splitTop(rule.selector)) {
    const { selectors, notes } = lowerSelector(selector);
    for (const note of notes) context.report.count(`selector: ${note}`);
    if (selectors.length === 0) context.report.note("selector dropped", `${context.file}: ${selector}`);
    kept.push(...selectors);
  }
  const unique = [...new Set(kept)];
  rule.selector = unique.join(", ");
  return unique.length > 0;
};

/** `:focus-within` is Chromium 60's: one engine in a list that doesn't know it drops the list, so those selectors get a rule of their own. */
const splitFocusWithin = (rule, report) => {
  const all = splitTop(rule.selector);
  const within = all.filter((selector) => selector.includes(":focus-within"));
  if (within.length === 0 || within.length === all.length) return [rule];
  report.count("selector: focus-within split off", within.length);
  return [
    { ...rule, selector: all.filter((selector) => !within.includes(selector)).join(", ") },
    { ...rule, nodes: rule.nodes.map((node) => ({ ...node })), selector: within.join(", ") },
  ];
};

// ---------- declarations ----------

const BOX_SIDES = { top: 0, right: 1, bottom: 2, left: 3 };

/** `a b c d` expanded to the four sides, as the box shorthands do. */
const sidesOf = (values) => {
  const [a, b = a, c = a, d = b] = values;
  return { top: a, right: b, bottom: c, left: d };
};

/** Logical box properties, written for a left-to-right page (these engines have no :dir() to tell them otherwise). */
const lowerLogical = (node, report) => {
  const { prop, value, important } = node;
  const make = (pairs) => pairs.map(([p, v]) => decl(p, v, important));
  const values = spaces(value);
  let out = null;
  if (prop === "inset") {
    const sides = sidesOf(values);
    out = make(Object.keys(BOX_SIDES).map((side) => [side, sides[side]]));
  } else if (/^(margin|padding|inset)-(inline|block)$/.test(prop)) {
    const [, kind, axis] = /^(margin|padding|inset)-(inline|block)$/.exec(prop);
    const [start, end = start] = values;
    const name = (side) => (kind === "inset" ? side : `${kind}-${side}`);
    out = axis === "inline" ? make([[name("left"), start], [name("right"), end]]) : make([[name("top"), start], [name("bottom"), end]]);
  } else if (/^(margin|padding|inset)-(inline|block)-(start|end)$/.test(prop)) {
    const [, kind, axis, edge] = /^(margin|padding|inset)-(inline|block)-(start|end)$/.exec(prop);
    const side = axis === "inline" ? (edge === "start" ? "left" : "right") : edge === "start" ? "top" : "bottom";
    out = make([[kind === "inset" ? side : `${kind}-${side}`, value]]);
  }
  if (out) report.count(`logical: ${prop}`);
  return out ?? [node];
};

/** Individual transform properties (Chromium 104) folded into `transform`, where the rule has no transform of its own to be ordered against. */
const foldTransforms = (nodes, context) => {
  const individual = nodes.filter((node) => node.type === "decl" && ["translate", "scale", "rotate"].includes(node.prop));
  if (individual.length === 0) return nodes;
  const hasTransform = nodes.some((node) => node.type === "decl" && node.prop === "transform");
  const convert = (node) => {
    const values = spaces(node.value);
    if (node.value.trim() === "none") return "";
    if (node.value.includes("var(")) return null;
    if (node.prop === "translate") return values.length === 3 ? `translate3d(${values.join(", ")})` : `translate(${values.join(", ")})`;
    if (node.prop === "scale") return `scale(${values.slice(0, 2).join(", ")})`;
    return values.length === 1 ? `rotate(${values[0]})` : null;
  };
  const functions = individual.map(convert);
  if (hasTransform || functions.includes(null)) {
    for (const node of individual) context.report.note("transform property left", `${context.file}: ${context.selector} { ${node.prop}: ${node.value} }${hasTransform ? " (the rule has its own transform)" : ""}`);
    return nodes;
  }
  const at = nodes.indexOf(individual[0]);
  const folded = decl("transform", functions.filter(Boolean).join(" ") || "none", individual[0].important);
  context.report.count("transform: folded", individual.length);
  return nodes.flatMap((node, index) => (index === at ? [folded] : individual.includes(node) ? [] : [node]));
};

const lowerMath = (nodes, context) =>
  nodes.flatMap((node) => {
    if (node.type !== "decl" || !hasMath(node.value)) return [node];
    const reduced = { ...node, value: reduceMath(node.value) };
    if (node.prop.startsWith("--")) {
      // A custom property isn't checked where it is declared, so a fallback declaration before it
      // would never be used: where it is read, it parses or the property is lost.
      context.report.count("math: custom property replaced");
      return [reduced];
    }
    if (node.value.includes("var(")) {
      // The same holds for a value that reads one: it always parses, so the later declaration would
      // win in an engine that can't use it, and the property would be lost there too.
      context.report.count("math: var() declaration replaced");
      return [reduced];
    }
    context.report.count("math: fallback added");
    return [reduced, node];
  });

const MIX = /color-mix\(/g;

/** The `color-mix(...)` calls in a value, as `{ start, end, args }`. */
const colorMixes = (value) => {
  const calls = [];
  for (const match of value.matchAll(MIX)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < value.length; end++) {
      if (value[end] === "(") depth++;
      else if (value[end] === ")" && --depth === 0) break;
    }
    calls.push({ start: match.index, end: end + 1, args: splitTop(value.slice(match.index + match[0].length, end)) });
  }
  return calls.filter((call, index) => !calls.some((other, at) => at < index && other.start <= call.start && other.end >= call.end));
};

/** `color-mix(in srgb, <color> p%, <color> q%)`'s operands, the one that is a plain `var()` first, with the share it takes. */
const mixOperands = (args) => {
  if (args.length !== 3 || !/^in\s+srgb$/i.test(args[0].trim())) return null;
  const [a, b] = args.slice(1).map((arg) => {
    const match = /^(.*?)(?:\s+(\d*\.?\d+)%)?$/.exec(arg.trim());
    return { color: match[1].trim(), percent: match[2] === undefined ? null : Number(match[2]) };
  });
  const share = a.percent ?? (b.percent === null ? 50 : 100 - b.percent);
  const swap = /^transparent$/i.test(a.color) && /^var\(--[\w-]+\)$/.test(b.color);
  return swap ? { a: b.color, b: a.color, percent: 100 - share } : { a: a.color, b: b.color, percent: share };
};

const derivedName = (token, percent) => `${token}-mix-${String(percent).replace(".", "_")}`;

/**
 * color-mix(in srgb, var(--token) p%, transparent) is the token's colour at p% of its alpha. A
 * token changes with the scheme, so the mix can't be worked out in the place that reads it; it is
 * worked out beside each declaration of the token instead, as a custom property of its own, and
 * read from there.
 */
const lowerColorMix = (nodes, context) => {
  return nodes.map((node) => {
    if (node.type !== "decl" || !node.value.includes("color-mix(")) return node;
    let value = node.value;
    for (const call of colorMixes(value).reverse()) {
      const operands = mixOperands(call.args);
      const variable = operands && /^var\((--[\w-]+)\)$/.exec(operands.a);
      const faded = variable && /^transparent$/i.test(operands.b);
      let replacement;
      if (faded) {
        const name = derivedName(variable[1], operands.percent);
        context.needed.add(`${variable[1]}|${operands.percent}`);
        const known = context.tokens.get(variable[1]);
        replacement = `var(${name}${known ? `, ${formatColor(fade(known, operands.percent))}` : ""})`;
        context.report.count("color-mix: token mix");
      } else {
        const first = operands ? parseColor(operands.a) : null;
        const second = operands ? parseColor(operands.b) : null;
        if (first && second) {
          // Literals lightningcss left (it resolves most): mixed here.
          const p = operands.percent / 100;
          const alpha = first.a * p + second.a * (1 - p);
          const channel = (key) => (alpha === 0 ? 0 : Math.round((first[key] * first.a * p + second[key] * second.a * (1 - p)) / alpha));
          replacement = formatColor({ r: channel("r"), g: channel("g"), b: channel("b"), a: alpha });
          context.report.count("color-mix: literal mix");
        } else {
          // Something this can't resolve: the first colour, solid, so the declaration still draws.
          replacement = call.args[1]?.replace(/\s+\d*\.?\d+%$/, "").trim() ?? "transparent";
          context.report.note("color-mix unresolved", `${context.file}: ${context.selector} { ${node.prop}: ${node.value} } -> ${replacement}`);
        }
      }
      value = value.slice(0, call.start) + replacement + value.slice(call.end);
    }
    return { ...node, value };
  });
};

const lowerOverflowClip = (nodes, report) =>
  nodes.map((node) => {
    if (node.type !== "decl" || !/^overflow(-[xy])?$/.test(node.prop) || !/\bclip\b/.test(node.value)) return node;
    report.count("overflow: clip -> hidden");
    return { ...node, value: node.value.replace(/\bclip\b/g, "hidden") };
  });

/** Chromium before 76 has no backdrop-filter: a pane that relied on blur to be readable is made close to opaque instead. */
const lowerGlass = (nodes, context) => {
  const blurred = nodes.some((node) => node.type === "decl" && /^(-webkit-)?backdrop-filter$/.test(node.prop) && node.value.trim() !== "none");
  return nodes.map((node) => {
    if (node.type !== "decl") return node;
    const colour = (blurred && /^background(-color)?$/.test(node.prop)) || GLASS_TOKENS.has(node.prop) ? parseColor(node.value) : null;
    const target = GLASS_TOKENS.has(node.prop) ? GLASS_ALPHA : BLURRED_BACKGROUND_ALPHA;
    if (!colour || colour.a >= target || colour.a === 0) return node;
    context.report.count(GLASS_TOKENS.has(node.prop) ? "glass: token made opaque" : "glass: blurred background made opaque");
    return { ...node, value: formatColor({ ...colour, a: target }) };
  });
};

// ---------- gap, aspect-ratio: rewrites that add rules ----------

const gapValues = (nodes) => {
  let row = null;
  let column = null;
  for (const node of nodes) {
    if (node.type !== "decl") continue;
    const values = spaces(node.value);
    if (node.prop === "gap" || node.prop === "grid-gap") [row, column] = [values[0], values[1] ?? values[0]];
    else if (node.prop === "row-gap" || node.prop === "grid-row-gap") row = values[0];
    else if (node.prop === "column-gap" || node.prop === "grid-column-gap") column = values[0];
  }
  return { row, column };
};

const zero = (value) => (value === undefined || value === null || value === "normal" ? "0" : value);

/**
 * `gap` on a flex container (Chromium 84) as margins on its children: before every child but the
 * first for a row or column that doesn't wrap; after every child, which leaves the last one's
 * margin as trailing space, for a wrapping row that starts at the start edge. On a grid it is the
 * older grid-gap. What the container is comes from its own rule or the others that style the same
 * element.
 */
const lowerGap = (rule, context) => {
  const own = rule.nodes.filter((node) => node.type === "decl" && /^(grid-)?(row-|column-)?gap$/.test(node.prop));
  if (own.length === 0) return { rule, extra: [] };
  const { row, column } = gapValues(rule.nodes);
  const buckets = { "margin-left": [], "margin-right": [], "margin-top": [], "margin-bottom": [], wrap: [] };
  let grid = false;
  let handled = true;
  for (const selector of splitTop(rule.selector)) {
    const subject = subjectOf(selector);
    const fact = (prop) => rule.nodes.filter((node) => node.type === "decl" && node.prop === prop).pop()?.value.toLowerCase() ?? context.index.value(subject, prop, context.position);
    const display = fact("display");
    const flow = fact("flex-flow") ?? "";
    const direction = fact("flex-direction") ?? (/column-reverse/.test(flow) ? "column-reverse" : /column/.test(flow) ? "column" : /row-reverse/.test(flow) ? "row-reverse" : "row");
    const wrap = fact("flex-wrap") ?? (/wrap/.test(flow) && !/nowrap/.test(flow) ? "wrap" : "nowrap");
    const justify = fact("justify-content") ?? "normal";
    if (/grid/.test(display ?? "")) {
      grid = true;
    } else if (!/flex/.test(display ?? "") || pseudoElementOf(selector)) {
      context.report.note("gap left (not a flex or grid container here)", `${context.file}: ${selector}`);
      handled = false;
    } else if (wrap !== "nowrap") {
      if (direction === "row" && /^(normal|flex-start|start|left)$/.test(justify)) {
        buckets.wrap.push(selector);
      } else {
        context.report.note("gap left (wrapping flex container that isn't a plain row)", `${context.file}: ${selector} (${direction}, ${justify})`);
        handled = false;
      }
    } else {
      const side = { row: "margin-left", "row-reverse": "margin-right", column: "margin-top", "column-reverse": "margin-bottom" }[direction];
      buckets[side].push(selector);
    }
  }

  // The containers that now have margins in place of a gap, for the script that gives their bare text a box (polyfills/layout.js).
  for (const selectors of Object.values(buckets)) for (const selector of selectors) if (!selector.includes(":focus-within")) context.report.flexContainers.add(selector);
  const extra = [];
  const important = own.some((node) => node.important);
  const children = (selectors, combinator, nodes) => ({ type: "rule", selector: selectors.map((selector) => `${selector} > ${combinator}`).join(", "), nodes });
  for (const [prop, value] of [["margin-left", column], ["margin-right", column], ["margin-top", row], ["margin-bottom", row]]) {
    if (buckets[prop].length === 0) continue;
    extra.push(children(buckets[prop], "* + *", [decl(prop, zero(value), important)]));
    context.report.count(`gap: flex ${prop} on later children`, buckets[prop].length);
  }
  if (buckets.wrap.length) {
    extra.push(children(buckets.wrap, "*", [decl("margin-right", zero(column), important), decl("margin-bottom", zero(row), important)]));
    context.report.count("gap: wrapping flex row, margins on every child", buckets.wrap.length);
  }

  let nodes = rule.nodes;
  if (grid) {
    // Chromium 57 to 83 read it as grid-gap.
    nodes = nodes.flatMap((node) => (node.type === "decl" && /^(row-|column-)?gap$/.test(node.prop) ? [{ ...node, prop: `grid-${node.prop}` }, node] : [node]));
    context.report.count("gap: grid-gap added");
  }
  // A flex rule whose every selector became margins has nothing left for gap to do.
  if (handled && !grid && extra.length) nodes = nodes.filter((node) => !own.includes(node));
  return { rule: { ...rule, nodes }, extra };
};

const ratioPercent = (value) => {
  const match = /^(\d*\.?\d+)\s*(?:\/\s*(\d*\.?\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [width, height] = [Number(match[1]), Number(match[2] ?? 1)];
  return width > 0 && height > 0 ? Math.round((height / width) * 100 * 10000) / 10000 : null;
};

/**
 * `aspect-ratio` (Chromium 88) as a spacer: a zero-width float with padding-top of the ratio in the
 * element's ::before, so the box is at least that tall whatever it holds. A float is only held
 * inside a box that is its own formatting context (overflow, inline-block, positioned), so any
 * other element gets an ::after to clear it, and must have both pseudo-elements free. An <img>
 * that is a child of a positioned box is taken out of the flow, filling the box as it did before.
 */
const lowerAspectRatio = (rule, context) => {
  const ratios = rule.nodes.filter((node) => node.type === "decl" && node.prop === "aspect-ratio");
  if (ratios.length === 0) return { rule, extra: [] };
  const percent = ratioPercent(ratios[ratios.length - 1].value);
  const spacers = [];
  const clears = [];
  const images = [];
  for (const selector of splitTop(rule.selector)) {
    const subject = subjectOf(selector);
    const tag = /^[a-z][\w-]*/i.exec(subject)?.[0].toLowerCase();
    const display = context.index.value(subject, "display", context.position) ?? "block";
    const own = (prop, test) => context.index.has(subject, prop, test);
    const contained = own("overflow", (v) => !/visible/.test(v)) || own("overflow-x", (v) => !/visible/.test(v)) || own("overflow-y", (v) => !/visible/.test(v)) || /flow-root|inline-block/.test(display) || own("position", (v) => /absolute|fixed/.test(v)) || own("float", (v) => v !== "none");
    let reason = null;
    if (percent === null) reason = `value "${ratios[ratios.length - 1].value}"`;
    else if (pseudoElementOf(selector)) reason = "pseudo-element";
    else if (context.index.pseudo.has(`${subject}::before`)) reason = "the element has a ::before rule of its own";
    else if (!contained && context.index.pseudo.has(`${subject}::after`)) reason = "the element has an ::after rule of its own and is no formatting context to hold a float";
    else if (tag && REPLACED.has(tag)) reason = `<${tag}> draws no pseudo-elements`;
    else if (/flex|grid|table|contents|none/.test(display)) reason = `display: ${display}`;
    if (reason) {
      context.report.note("aspect-ratio left", `${context.file}: ${selector} (${reason})`);
      continue;
    }
    spacers.push(selector);
    if (!contained) clears.push(selector);
    if (own("position", (v) => /relative|absolute|fixed/.test(v))) images.push(selector);
  }

  const extra = [];
  if (spacers.length) {
    extra.push({ type: "rule", selector: spacers.map((selector) => `${selector}::before`).join(", "), nodes: [decl("content", '""'), decl("float", "left"), decl("width", "0"), decl("padding-top", `${percent}%`)] });
    context.report.count("aspect-ratio: spacer", spacers.length);
  }
  if (clears.length) extra.push({ type: "rule", selector: clears.map((selector) => `${selector}::after`).join(", "), nodes: [decl("content", '""'), decl("display", "table"), decl("clear", "both")] });
  if (images.length) extra.push({ type: "rule", selector: images.map((selector) => `${selector} > img`).join(", "), nodes: [decl("position", "absolute"), decl("top", "0"), decl("left", "0")] });
  const every = spacers.length === splitTop(rule.selector).length;
  return { rule: every ? { ...rule, nodes: rule.nodes.filter((node) => !ratios.includes(node)) } : rule, extra };
};

// ---------- the walk ----------

const transformNodes = (nodes, context) => {
  const out = [];
  for (const node of nodes) {
    if (node.type === "atrule" && node.nodes && GROUPING.has(node.name)) {
      out.push({ ...node, nodes: transformNodes(node.nodes, context) });
      continue;
    }
    if (node.type !== "rule") {
      out.push(node);
      continue;
    }

    context.selector = node.selector;
    context.position = context.index.position++;
    const rule = { ...node, nodes: [...node.nodes] };
    if (!lowerSelectors(rule, context)) {
      context.report.count("rules dropped (no selector left)");
      continue;
    }
    context.selector = rule.selector;

    let body = rule.nodes.flatMap((child) => (child.type === "decl" ? lowerLogical(child, context.report) : [child]));
    body = lowerOverflowClip(body, context.report);
    body = foldTransforms(body, context);
    body = lowerGlass(body, context);
    body = lowerColorMix(body, context);
    body = lowerMath(body, context);
    rule.nodes = body;

    const gap = lowerGap(rule, context);
    const ratio = lowerAspectRatio(gap.rule, context);
    // A rule that said only `aspect-ratio` has nothing left once its spacer is a rule of its own.
    if (ratio.rule.nodes.length) for (const piece of splitFocusWithin(ratio.rule, context.report)) out.push(piece);
    out.push(...gap.extra, ...ratio.extra);
  }
  return out;
};

/** Adds, beside every declaration of a token that a color-mix reads, the mix worked out for that declaration. */
const addDerivedTokens = (nodes, context) => {
  for (const node of nodes) {
    if (node.type === "atrule" && node.nodes && GROUPING.has(node.name)) addDerivedTokens(node.nodes, context);
    if (node.type !== "rule") continue;
    node.nodes = node.nodes.flatMap((child) => {
      if (child.type !== "decl" || !child.prop.startsWith("--")) return [child];
      const colour = parseColor(child.value);
      const mixes = [...context.needed].map((entry) => entry.split("|")).filter(([token]) => token === child.prop);
      if (!colour || mixes.length === 0) return [child];
      context.report.count("color-mix: token mixes written", mixes.length);
      return [child, ...mixes.map(([token, percent]) => decl(derivedName(token, Number(percent)), formatColor(fade(colour, Number(percent))), child.important))];
    });
  }
};

/** The literal colour each token is first declared as, for the fallback inside var(). */
const tokenColours = (trees) => {
  const tokens = new Map();
  for (const tree of trees) {
    eachRule(tree.nodes, (rule) => {
      for (const node of rule.nodes) {
        if (node.type === "decl" && node.prop.startsWith("--") && !tokens.has(node.prop)) {
          const colour = parseColor(node.value);
          if (colour) tokens.set(node.prop, colour);
        }
      }
    });
  }
  return tokens;
};

const survey = (trees, report) => {
  for (const tree of trees) {
    const visit = (nodes) => {
      for (const node of nodes) {
        if (node.type === "atrule" && node.name === "container") report.count("left: @container blocks");
        if (node.type === "atrule" && node.nodes && GROUPING.has(node.name)) visit(node.nodes);
        if (node.type !== "rule") continue;
        const decls = node.nodes.filter((child) => child.type === "decl");
        const has = (test) => decls.some((child) => test(child.prop, child.value.toLowerCase()));
        if (has((p, v) => p === "display" && /grid/.test(v))) {
          report.count("left: display grid rules (no CSS Grid before Chromium 57)");
          report.note("left: display grid (laid out as blocks on Chromium 53 to 56)", `${tree.name}: ${node.selector.replace(/\s+/g, " ")}`);
        }
        if (has((p, v) => p === "display" && v === "contents")) report.count("left: display contents rules (Chromium 65)");
        if (has((p, v) => /^(-webkit-)?backdrop-filter$/.test(p) && v !== "none")) report.count("left: backdrop-filter rules (no blur before Chromium 76)");
        if (has((p) => /^scroll-snap-/.test(p))) report.count("left: scroll-snap rules (Chromium 69)");
        if (has((p) => p === "scroll-behavior")) report.count("left: scroll-behavior rules (Chromium 61)");
        if (has((p, v) => p === "position" && /sticky/.test(v))) report.count("left: position sticky rules (Chromium 56)");
        if (has((p) => p === "container" || p === "container-type")) report.count("left: container-type rules (Chromium 105)");
        if (node.selector.includes(":focus-within")) report.count("left: :focus-within rules (Chromium 60)");
        if (has((p) => p === "inset" || /^inset-/.test(p))) report.count("left: inset properties");
        if (has((p) => p === "aspect-ratio")) report.count("left: aspect-ratio declarations");
      }
    };
    visit(tree.nodes);
  }
};

/**
 * @param {{ name: string, css: string }[]} files in cascade order
 * @param {{ chrome?: number, lightning?: boolean }} [options] `lightning: false` skips lightningcss (the tests of the transforms)
 * @returns {{ files: { name: string, css: string }[], report: Report }}
 */
export const lowerStylesheets = (files, { chrome = 53, lightning = true } = {}) => {
  const report = new Report();
  const trees = files.map(({ name, css }) => {
    let text = css;
    if (lightning) {
      const result = transform({ filename: name, code: Buffer.from(css), targets: { chrome: chrome << 16 }, minify: false, errorRecovery: true, exclude: KEEP });
      for (const warning of result.warnings) report.note("lightningcss warning", `${name}: ${warning.message}`);
      text = result.code.toString();
    }
    return { name, nodes: parse(text) };
  });

  const tokens = tokenColours(trees);
  const needed = new Set();
  const index = buildIndex(trees);
  index.position = 0;
  const context = { report, index, tokens, needed, file: "", selector: "", position: 0 };
  for (const tree of trees) {
    context.file = tree.name;
    tree.nodes = transformNodes(tree.nodes, context);
  }
  for (const tree of trees) addDerivedTokens(tree.nodes, context);
  survey(trees, report);
  return { files: trees.map((tree) => ({ name: tree.name, css: `${stringify(tree.nodes)}\n` })), report };
};

/** The report as text: every count, then every note with its places. */
export const describe = (report) => {
  const lines = [];
  for (const [name, count] of [...report.counts].sort(([a], [b]) => a.localeCompare(b))) lines.push(`${String(count).padStart(5)}  ${name}`);
  for (const [name, details] of [...report.notes].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("", `${name} (${details.length}):`, ...details.map((detail) => `  ${detail}`));
  }
  return lines.join("\n");
};
