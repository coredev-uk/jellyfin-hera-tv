// min(), max() and clamp() for engines that have none: each call is replaced by the one of its
// arguments that wins on a TV, so the legacy stylesheet gets a plain length where the modern one
// has a fluid one. Which argument wins is decided at the reference viewport below (the 1080p
// every Tizen and webOS TV browser reports), but the argument itself is kept as written, so a
// `vw` or `vh` still scales with the screen.
import { closing, splitTop } from "./css-model.mjs";

export const VIEWPORT = { width: 1920, height: 1080 };

const UNITS = {
  px: 1,
  vw: VIEWPORT.width / 100,
  vh: VIEWPORT.height / 100,
  vmin: Math.min(VIEWPORT.width, VIEWPORT.height) / 100,
  vmax: Math.max(VIEWPORT.width, VIEWPORT.height) / 100,
  rem: 16,
};

/** The value of a length expression in px at the reference viewport, or null where it depends on something else (a percentage, `var()`, `em`). */
export const evaluate = (text) => {
  const tokens = [...text.matchAll(/(\d*\.?\d+(?:e[+-]?\d+)?)([a-z%]*)|([()+\-*/,])|([a-z-]+)\(|(\S)/gi)];
  let at = 0;
  const peek = () => tokens[at];
  const op = (symbol) => peek()?.[3] === symbol;

  const sum = () => {
    let value = product();
    while (peek() && (op("+") || op("-"))) {
      const minus = tokens[at++][3] === "-";
      const right = product();
      value = value === null || right === null ? null : minus ? value - right : value + right;
    }
    return value;
  };
  const product = () => {
    let value = unary();
    while (peek() && (op("*") || op("/"))) {
      const divide = tokens[at++][3] === "/";
      const right = unary();
      value = value === null || right === null ? null : divide ? value / right : value * right;
    }
    return value;
  };
  const unary = () => {
    if (op("-")) {
      at++;
      const value = unary();
      return value === null ? null : -value;
    }
    if (op("+")) at++;
    return primary();
  };
  const args = () => {
    const values = [sum()];
    while (op(",")) {
      at++;
      values.push(sum());
    }
    if (op(")")) at++;
    return values;
  };
  const primary = () => {
    const token = peek();
    if (!token) return null;
    at++;
    if (token[1] !== undefined) {
      const unit = token[2].toLowerCase();
      if (unit === "") return Number(token[1]);
      return unit in UNITS ? Number(token[1]) * UNITS[unit] : null;
    }
    if (token[3] === "(") {
      const value = sum();
      if (op(")")) at++;
      return value;
    }
    if (token[4] !== undefined) {
      const name = token[4].toLowerCase();
      const values = args();
      if (values.includes(null)) return null;
      if (name === "calc") return values[0];
      if (name === "min") return Math.min(...values);
      if (name === "max") return Math.max(...values);
      if (name === "clamp") return Math.max(values[0], Math.min(values[1], values[2]));
      return null;
    }
    return null;
  };

  const value = tokens.length ? sum() : null;
  return at === tokens.length && value !== null ? Math.round(value * 10000) / 10000 : null;
};

/** `text` as an operand of a longer expression: a lone token or function stays, a sum gets its own calc(). */
const operand = (text) => (/^[\w.%+-]+$/.test(text) || (/^[\w-]+\(/.test(text) && closing(text, text.indexOf("(")) === text.length) ? text : `calc(${text})`);

const choose = (name, args) => {
  const values = args.map(evaluate);
  const known = args.map((_, index) => index).filter((index) => values[index] !== null);
  const pick = (better) => known.reduce((best, index) => (better(values[index], values[best]) ? index : best), known[0]);

  if (name === "clamp") {
    const [low, preferred, high] = values;
    if (args.length !== 3 || preferred === null) return 1 < args.length ? 1 : 0;
    if (low !== null && preferred < low) return 0;
    if (high !== null && preferred > high) return 2;
    return 1;
  }

  // An argument that reads a custom property is the one the author means; the others (a viewport or
  // container guard) only bound it.
  const variable = args.findIndex((arg, index) => values[index] === null && arg.includes("var("));
  if (variable >= 0) return variable;
  if (known.length === 0) return 0;
  return name === "min" ? pick((a, b) => a < b) : pick((a, b) => a > b);
};

/** `text` with every min(), max() and clamp() in it replaced by its winning argument. */
export const reduceMath = (text) => {
  const call = /(?<![\w-])(min|max|clamp)\(/i.exec(text);
  if (!call) return text;
  const open = call.index + call[0].length - 1;
  const end = closing(text, open);
  const name = call[1].toLowerCase();
  const args = splitTop(text.slice(open + 1, end - 1)).map(reduceMath);
  const winner = operand(args[choose(name, args)] ?? "0");
  return reduceMath(text.slice(0, call.index) + winner + text.slice(end));
};

export const hasMath = (text) => /(?<![\w-])(min|max|clamp)\(/i.test(text);
