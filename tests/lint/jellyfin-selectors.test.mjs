// `node --test "tests/**/*.test.mjs"`: the rule must catch a Jellyfin class in a selector and
// leave prose, URLs, Hera's own names and the JF map alone.
import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import rule from "./jellyfin-selectors.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

new RuleTester({ languageOptions: { ecmaVersion: "latest", sourceType: "script" } }).run("jellyfin-selectors", rule, {
  valid: [
    'page.querySelector(".hera-hero")',
    'page.querySelectorAll(`${jf.page} .hera-seasons[data-item="1"]`)',
    'node.closest("[data-hera-hs]")',
    'node.matches(".hera-hero__slide.is-active .hera-btn--primary")',
    'el.querySelector(\'[href="#/search"]\')',
    // The JF map is where Jellyfin's names live.
    'const JF = Object.freeze({ page: ".page:not(.hide)", appBar: ".MuiAppBar-root" });',
    // Not selectors.
    'const url = "https://image.tmdb.org/t/p/";',
    'const note = "Nothing is playing. Try again.";',
    'const file = "hera-bundle.js";',
    'const colour = "#ffffff";',
    'const hash = "#/details?id=";',
    'el("div", { class: "mediaInfoItem hera-x" })',
  ],
  invalid: [
    { code: 'page.querySelector(".detailRibbon")', errors: [{ messageId: "raw", data: { selector: ".detailRibbon", kind: "class", name: "detailRibbon" } }] },
    { code: 'document.querySelector("#itemBackdrop")', errors: [{ messageId: "raw", data: { selector: "#itemBackdrop", kind: "id", name: "itemBackdrop" } }] },
    { code: "page.closest(`${jf.appBar} > .MuiToolbar-root`)", errors: [{ messageId: "raw" }] },
    { code: 'const BUTTON = ".headerSearchButton, .hera-x";', errors: [{ messageId: "raw" }] },
    { code: 'el.querySelector(".hera-x .material-icons")', errors: [{ messageId: "raw" }] },
    { code: 'el.querySelector(".is-active")', errors: [{ messageId: "raw" }] },
    { code: 'const notJf = { page: ".page:not(.hide)" };', errors: [{ messageId: "raw" }] },
  ],
});
