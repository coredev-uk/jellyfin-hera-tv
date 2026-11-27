// An ESLint rule: Jellyfin's markup is named in one place, the JF map of web/hera-tv.js, so a
// Jellyfin release that renames something is reported (a module that cannot find a piece says so)
// and fixed in one line. A selector written anywhere else names a class or id of Jellyfin's that
// nothing checks: it matches nothing after the rename and the feature goes quiet with every
// health report still ok.
//
// A selector literal is one passed to querySelector, querySelectorAll, closest, matches or
// waitForSelector, or any other string that has the shape of one. It may name Hera's own classes and
// ids (hera-…) and any attribute (an attribute selector is not a class or id), nothing else.
// Literals inside the JF map are the one place Jellyfin's names live. An exception that is not a
// Jellyfin name (a class from another library, the page's own) takes an eslint-disable comment
// with its reason.

const CALLS = new Set(["querySelector", "querySelectorAll", "closest", "matches", "waitForSelector"]);

/** The map of Jellyfin's selectors, and the storage keys beside it, by the names core declares them under. */
const MAP_NAMES = /^(JF|JF_[A-Z_]+)$/;

// What a selector is made of; prose and URLs have more than this, or too many plain words.
const SHAPE = /^[\w\s.#:\[\]="'*>+~,()^$|/@%!&\\-]+$/;
const CLASS_OR_ID = /([.#])([A-Za-z_][\w-]*)/g;

// Hera's own state modifiers on its own components (`.hera-hero__slide.is-active`).
const STATE = /^(is|has)-[\w-]+$/;

const isHera = (name) => name === "hera" || name.startsWith("hera-") || name.startsWith("hera_");

/**
 * The class and id names in a selector that are not Hera's: attribute selectors and quoted text
 * are not names, and `is-…`/`has-…` classes are Hera's own state modifiers when the selector
 * names a Hera class too.
 */
export const foreignNames = (selector) => {
  const bare = selector.replace(/\[[^\]]*\]/g, "[]").replace(/"[^"]*"|'[^']*'/g, "");
  const names = [...bare.matchAll(CLASS_OR_ID)].map((match) => ({ kind: match[1] === "." ? "class" : "id", name: match[2] }));
  const ours = names.some(({ name }) => isHera(name));
  return names.filter(({ kind, name }) => !isHera(name) && !(ours && kind === "class" && STATE.test(name)));
};

/** Is this string, standing alone, shaped like a selector? Prose, URLs, file names and colours are not. */
export const looksLikeSelector = (text) => {
  const value = text.trim();
  if (value.length < 2 || !SHAPE.test(value)) return false;
  if (value.includes("://") || /^#[0-9a-f]{3,8}$/i.test(value)) return false;
  // `bundle.js`, `letterboxd.com/`: a word, dots, words.
  if (/^[\w-]+(\.[\w-]+)+[:/]?$/.test(value)) return false;
  if (/[.!?]\s+\S/.test(value) || /\.$/.test(value)) return false;
  if (/\s[a-z]{3,}\s[a-z]{3,}/.test(value)) return false;
  return true;
};

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Jellyfin's classes and ids are named in the JF map only" },
    schema: [],
    messages: {
      raw: 'Selector "{{selector}}" names Jellyfin\'s {{kind}} "{{name}}" outside the JF map. Add it to JF in web/hera-tv.js and look it up with kit.jf, so a rename is reported and fixed in one place.',
    },
  },
  create(context) {
    const inMap = (node) =>
      context.sourceCode.getAncestors(node).some((ancestor) => ancestor.type === "VariableDeclarator" && ancestor.id.type === "Identifier" && MAP_NAMES.test(ancestor.id.name));

    // The first argument of querySelector and its kin is a selector, whatever it looks like.
    const isSelectorArgument = (node) => {
      const call = node.parent;
      if (call?.type !== "CallExpression" || call.arguments[0] !== node) return false;
      const { callee } = call;
      const name = callee.type === "MemberExpression" && !callee.computed ? callee.property.name : callee.type === "Identifier" ? callee.name : null;
      return CALLS.has(name);
    };

    // The static parts of a template literal: `${jf.page} .foo` has ` .foo` to check.
    const textsOf = (node) => {
      if (node.type === "Literal") return typeof node.value === "string" ? [node.value] : [];
      return node.quasis.map((quasi) => quasi.value.cooked ?? "");
    };

    const check = (node) => {
      if (inMap(node)) return;
      const forced = isSelectorArgument(node);
      for (const text of textsOf(node)) {
        if (!forced && !looksLikeSelector(text)) continue;
        const [first] = foreignNames(text);
        if (!first) continue;
        context.report({ node, messageId: "raw", data: { selector: text.length > 60 ? `${text.slice(0, 57)}...` : text, kind: first.kind, name: first.name } });
        return;
      }
    };

    return { Literal: check, TemplateLiteral: check };
  },
};
