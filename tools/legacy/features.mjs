// What the scripts may call that Chromium 53 and 63 don't have, and what supplies it. The build
// reads the names the scripts use and adds the core-js modules for those; a name that needs
// something no polyfill here provides stops the build, so a new API can't reach a TV as a
// ReferenceError. The DOM stand-ins (polyfills/dom.js) are always included: they cost little.
//
// core-js modules that replace a built-in the browser already has (Promise, RegExp.prototype.exec,
// String.prototype.replace, Array.prototype.sort, JSON.stringify, Error) are never listed: they
// would change every script on the page, Jellyfin's own included, for features Hera doesn't use.

/** Member and global names -> the core-js modules that provide them. A dotted key is a static member (`Object.entries`). */
export const CORE_JS = {
  at: ["es.array.at", "es.string.at-alternative"],
  flat: ["es.array.flat", "es.array.unscopables.flat"],
  flatMap: ["es.array.flat-map", "es.array.unscopables.flat-map"],
  findLast: ["es.array.find-last"],
  findLastIndex: ["es.array.find-last-index"],
  toSorted: ["es.array.to-sorted"],
  toReversed: ["es.array.to-reversed"],
  toSpliced: ["es.array.to-spliced"],
  padStart: ["es.string.pad-start"],
  padEnd: ["es.string.pad-end"],
  trimStart: ["es.string.trim-start"],
  trimEnd: ["es.string.trim-end"],
  replaceAll: ["es.string.replace-all"],
  matchAll: ["es.string.match-all"],
  finally: ["es.promise.finally"],
  "Object.entries": ["es.object.entries"],
  "Object.values": ["es.object.values"],
  "Object.fromEntries": ["es.object.from-entries"],
  "Object.hasOwn": ["es.object.has-own"],
  "Object.groupBy": ["es.object.group-by"],
  "Object.getOwnPropertyDescriptors": ["es.object.get-own-property-descriptors"],
  "Promise.allSettled": ["es.promise.all-settled"],
  "Promise.any": ["es.promise.any"],
  queueMicrotask: ["web.queue-microtask"],
  globalThis: ["es.global-this"],
  structuredClone: ["web.structured-clone"],
};

/** Names with nothing to supply them: using one is a build error until a polyfill or a guard exists. */
export const UNAVAILABLE = ["WeakRef", "FinalizationRegistry", "Temporal", "ViewTransition", "startViewTransition", "CompressionStream", "DecompressionStream", "showPopover", "hidePopover", "requestSubmit", "Segmenter", "ListFormat", "RelativeTimeFormat", "DisplayNames"];
