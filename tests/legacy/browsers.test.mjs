// Which browsers are given the legacy assets: the patterns and floors are read out of
// LegacyBrowsers.cs itself and real User-Agent strings run through them, so an edit there that
// sends a current browser to the old assets (or an old one to the current) fails here. The few
// lines of decision are mirrored below; the patterns, the part that drifts, are not copied.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../../LegacyBrowsers.cs", import.meta.url)), "utf8");

const floor = (name) => Number(new RegExp(`const int ${name} = (\\d+);`).exec(source)?.[1]);
const pattern = (name) => {
  const match = new RegExp(`\\[GeneratedRegex\\(@"((?:[^"]|"")*)"(?:,\\s*RegexOptions\\.(\\w+))?\\)\\]\\s*private static partial Regex ${name}\\(\\)`).exec(source);
  assert.ok(match, `LegacyBrowsers.cs has no ${name} pattern`);
  return new RegExp(match[1].replaceAll('""', '"'), match[2] === "IgnoreCase" ? "i" : "");
};

const CHROME_FLOOR = floor("ChromeFloor");
const SAFARI_FLOOR = floor("SafariFloor");
const chrome = pattern("ChromeToken");
const samsung = pattern("SamsungEngineToken");
const tv = pattern("TvPlatform");
const safari = pattern("SafariVersion");

const isLegacy = (ua) => {
  if (!ua) return false;
  const engine = chrome.exec(ua) ?? samsung.exec(ua);
  if (engine) return Number(engine[1]) < CHROME_FLOOR;
  if (tv.test(ua)) return true;
  const version = safari.exec(ua);
  return version !== null && Number(version[1]) < SAFARI_FLOOR;
};

const MODERN = {
  "desktop Chrome 131": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Chrome 85, the first": "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36",
  "desktop Firefox": "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "desktop Safari 17": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "iPhone Safari 17": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  "Edge": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Jellyfin Android (WebView 120, which also says Version/4.0)": "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36",
  "Jellium (Electron)": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36",
  "Jellyfin Desktop (QtWebEngine 140)": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) JellyfinDesktop/1.0 QtWebEngine/6.8.1 Chrome/140.0.0.0 Safari/537.36",
  "Tizen 7 on Chromium 94": "Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.31 TV Safari/537.36",
  "Tizen 6 naming its engine by version (85)": "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.0 TV Safari/537.36",
  "webOS 6 on Chromium 94": "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.128 Safari/537.36 WebAppManager",
  "no User-Agent": "",
};

const LEGACY = {
  "Samsung Tizen 5.0 browser": "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/5.0 TV Safari/537.36",
  "Samsung TV on Chrome 63": "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.2 Chrome/63.0.3239.84 TV Safari/537.36",
  "Tizen 5.5 naming its engine by version (69)": "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106.1/5.5 TV Safari/537.36",
  "LG webOS 4 on Chromium 53": "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36 WebAppManager",
  "LG NetCast": "Mozilla/5.0 (Linux; NetCast; U) AppleWebKit/537.31 (KHTML, like Gecko) Large Screen WebKit",
  "Chrome 80": "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Safari/537.36",
  "Android 6 WebView on Chrome 74": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/74.0.3729.136 Mobile Safari/537.36",
  "desktop Safari 13": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.2 Safari/605.1.15",
  "iPhone Safari 12": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
};

test("the floors are Chromium 85 and Safari 14", () => {
  assert.equal(CHROME_FLOOR, 85);
  assert.equal(SAFARI_FLOOR, 14);
});

for (const [name, ua] of Object.entries(MODERN)) {
  test(`${name} gets the current assets`, () => assert.equal(isLegacy(ua), false));
}

for (const [name, ua] of Object.entries(LEGACY)) {
  test(`${name} gets the legacy assets`, () => assert.equal(isLegacy(ua), true));
}

test("the C# rule has the three parts the mirror above runs", () => {
  const body = source.slice(source.indexOf("public static bool IsLegacy"));
  for (const part of ["ChromeToken()", "SamsungEngineToken()", "TvPlatform()", "SafariVersion()", "ChromeFloor", "SafariFloor"]) {
    assert.ok(body.includes(part), `IsLegacy no longer uses ${part}; update this test's mirror of it`);
  }
});
