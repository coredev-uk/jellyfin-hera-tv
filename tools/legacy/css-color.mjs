// Colours for the legacy stylesheet's color-mix() fallback: just enough of CSS Color to read the
// literal values Hera's tokens are written in and to write one back as rgba().
import { splitTop } from "./css-model.mjs";

const NAMED = { transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1] };

const channel = (text) => {
  const number = parseFloat(text);
  return text.endsWith("%") ? Math.round((number * 255) / 100) : Math.round(number);
};

const alphaOf = (text) => {
  const number = parseFloat(text);
  return text.endsWith("%") ? number / 100 : number;
};

/** @returns {{ r: number, g: number, b: number, a: number } | null} the colour a literal (hex, rgb(), rgba(), transparent, white, black) names. */
export const parseColor = (text) => {
  const value = text.trim().toLowerCase();
  if (value in NAMED) {
    const [r, g, b, a] = NAMED[value];
    return { r, g, b, a };
  }
  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex && [3, 4, 6, 8].includes(hex[1].length)) {
    const digits = hex[1].length < 6 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    const [r, g, b, a] = [0, 2, 4, 6].map((at) => (digits.length > at ? parseInt(digits.slice(at, at + 2), 16) : 255));
    return { r, g, b, a: Math.round((a / 255) * 1000) / 1000 };
  }
  const fn = /^rgba?\((.*)\)$/.exec(value);
  if (fn) {
    const parts = fn[1].includes(",") ? splitTop(fn[1]) : fn[1].split(/\s*\/\s*|\s+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4 || parts.some((part) => /var\(|calc\(|none/.test(part))) return null;
    const [r, g, b] = parts.slice(0, 3).map(channel);
    return { r, g, b, a: parts.length === 4 ? alphaOf(parts[3]) : 1 };
  }
  return null;
};

const round = (n) => Math.round(n * 1000) / 1000;

export const formatColor = ({ r, g, b, a }) => (a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${round(a)})`);

/** The colour with `percent`% of its own alpha, which is what mixing it with transparent in sRGB gives. */
export const fade = (color, percent) => ({ ...color, a: color.a * (percent / 100) });

/** Mixes two colours in sRGB, premultiplied, the way color-mix(in srgb, a p%, b q%) does (percentages are shares of the pair). */
export const mixColors = (first, second, percent) => {
  const p = percent / 100;
  const a = first.a * p + second.a * (1 - p);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mixed = (key) => Math.round((first[key] * first.a * p + second[key] * second.a * (1 - p)) / a);
  return { r: mixed("r"), g: mixed("g"), b: mixed("b"), a };
};
