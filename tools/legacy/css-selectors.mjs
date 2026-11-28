// Selectors for engines before Chromium 88, which know no :is(), :where(), :has(), a :not() with a
// list or a compound, or :focus-visible. A browser drops a whole rule for one selector it can't
// read, so each selector is rewritten into ones it can, or removed, and the rest of the list lives.
import { closing, findFunction, splitComplex, splitCompound, splitTop } from "./css-model.mjs";

const MAX_ALTERNATIVES = 32;

const FUNCTIONS = ["has", "is", "where", "matches", "-webkit-any", "not"];

const unique = (list) => [...new Set(list)];

/**
 * Rewrites one complex selector for Chromium 53 to 87.
 * @returns {{ selectors: string[], notes: string[] }} what it became (empty when it can't be written
 * for these engines) and what was done, as a list of: has, is, where, not-list, not-compound,
 * not-complex, is-complex, focus-visible.
 */
export const lowerSelector = (selector) => {
  const notes = [];
  let selectors = expand(selector.trim(), notes);
  if (selectors.length > MAX_ALTERNATIVES) {
    notes.push("too-many");
    selectors = [];
  }
  selectors = selectors.map((one) => {
    const plain = one.replace(/:focus-visible(?![\w-])/g, ":focus");
    if (plain !== one) notes.push("focus-visible");
    return plain;
  });
  return { selectors: unique(selectors), notes };
};

const isSimple = (arg) => splitComplex(arg).length === 1 && splitCompound(arg).length === 1 && !/:(?:not|is|where|has|matches|-webkit-any)\(/.test(arg);

// A :not() that already holds one simple selector is what the old engines read; it is the only
// function that can be left as it is.
const firstToRewrite = (selector) => {
  let best = null;
  for (const name of FUNCTIONS) {
    for (let from = 0; ; ) {
      const found = findFunction(selector, [name], from);
      if (!found) break;
      from = found.start + 1;
      const args = splitTop(selector.slice(found.open + 1, found.close - 1));
      if (name === "not" && args.length === 1 && isSimple(args[0])) continue;
      if (!best || found.start < best.start) best = found;
      break;
    }
  }
  return best;
};

const expand = (selector, notes) => {
  // The first function that opens is the outermost: what is inside it is dealt with with it.
  const found = firstToRewrite(selector);
  if (!found) return [selector];
  const before = selector.slice(0, found.start);
  const after = selector.slice(found.close);
  const args = splitTop(selector.slice(found.open + 1, found.close - 1));

  if (found.name === "has") {
    notes.push("has");
    return [];
  }

  if (found.name === "not") return expandNot(before, args, after, notes);

  // :is() and :where() stand for any of their arguments. A complex argument can take the place of
  // a whole compound; one that is attached to other simple selectors (`a:is(b c)`) has nowhere to go.
  const whole = /(^|[\s>+~])$/.test(before) && /^($|[\s>+~])/.test(after);
  notes.push(found.name === "where" ? "where" : "is");
  const out = [];
  for (const arg of args) {
    if (!whole && (splitComplex(arg).length > 1 || /^[a-z*]/i.test(arg))) {
      notes.push("is-complex");
      continue;
    }
    out.push(...expand(before + arg + after, notes));
  }
  return out;
};

// :not(a, b.c) is not(a) and not(b.c); and not(b.c) is not(b) or not(.c). Older engines take one
// simple selector in :not(), so the "and" is a chain and the "or" is a list of selectors.
const expandNot = (before, args, after, notes) => {
  // :not(:is(a, b)) is :not(a, b).
  const flat = args.flatMap((arg) => {
    const inner = /^:(?:is|where|matches)\(/.exec(arg);
    return inner && closing(arg, inner[0].length - 1) === arg.length ? splitTop(arg.slice(inner[0].length, -1)) : [arg];
  });
  if (flat.length > 1) notes.push("not-list");

  const choices = [];
  for (const arg of flat) {
    if (splitComplex(arg).length > 1 || /:(?:not|is|where|has|matches)\(/.test(arg)) {
      notes.push("not-complex");
      return [];
    }
    const simples = splitCompound(arg);
    if (simples.length > 1) notes.push("not-compound");
    choices.push(simples.map((simple) => `:not(${simple})`));
  }

  let combos = [""];
  for (const options of choices) {
    combos = combos.flatMap((chain) => options.map((option) => chain + option));
    if (combos.length > MAX_ALTERNATIVES) return combos;
  }
  return combos.flatMap((chain) => expand(before + chain + after, notes));
};

/** The part of a selector that names the element it is about: its last compound without pseudo-classes and pseudo-elements, `.a` for `.x > .a:hover::before`. */
export const subjectOf = (selector) => {
  const compounds = splitComplex(selector);
  if (compounds.length === 0) return "";
  const simples = splitCompound(compounds[compounds.length - 1].compound).filter((simple) => !simple.startsWith(":"));
  return simples.join("") || "*";
};

/** The pseudo-element a selector ends in (`before`, `after`, `placeholder`...), or null. */
export const pseudoElementOf = (selector) => {
  const compounds = splitComplex(selector);
  if (compounds.length === 0) return null;
  const last = splitCompound(compounds[compounds.length - 1].compound).find((simple) => simple.startsWith("::") || /^:(before|after|first-line|first-letter)$/.test(simple));
  return last ? last.replace(/^::?/, "").toLowerCase() : null;
};
