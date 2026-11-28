/*
 * Hera's flex `gap`, for the part of it a stylesheet can't reach. Where the legacy stylesheet turns a
 * gap into a margin on every element after the first, a bare run of text next to an icon
 * (`<button><svg/>More info</button>`) gets none, because CSS has no way to name a text node. This
 * wraps such text in a span, as the flex container would have treated it, so the margin has an
 * element to land on. Plain ES5, run after the DOM stand-ins.
 */
(function () {
  "use strict";

  var doc = document;
  if (!window.MutationObserver) return;

  // The selectors of the flex containers whose gap the stylesheet turned into margins, put in by the
  // build. Not read from computed style: a script that adds a button hears of it before the
  // stylesheet's rules have reached it, and `display` would still say inline-block.
  var probe = doc.createElement("div");
  var CONTAINERS = __HERA_FLEX_CONTAINERS__.filter(function (selector) {
    try {
      probe.matches(selector);
      return true;
    } catch (e) {
      return false;
    }
  });
  if (CONTAINERS.length === 0) return;
  var FLEX = CONTAINERS.join(",");

  var wrapText = function (element) {
    var nodes = element.childNodes;
    var hasElement = false;
    var texts = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType === 1) hasElement = true;
      else if (nodes[i].nodeType === 3 && /\S/.test(nodes[i].nodeValue)) texts.push(nodes[i]);
    }
    if (!hasElement || texts.length === 0) return;
    if (!element.matches(FLEX)) return;
    texts.forEach(function (text) {
      var span = doc.createElement("span");
      element.insertBefore(span, text);
      span.appendChild(text);
    });
  };

  var scan = function (root) {
    if (root.nodeType !== 1) return;
    if (/(^|\s)hera-/.test(root.className)) wrapText(root);
    var inside = root.querySelectorAll('[class*="hera-"]');
    for (var i = 0; i < inside.length; i++) wrapText(inside[i]);
  };

  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (record.type === "characterData") continue;
      for (var j = 0; j < record.addedNodes.length; j++) {
        var added = record.addedNodes[j];
        // A span this made is not looked at again; text put back into an element is.
        if (added.nodeType === 1) scan(added);
        else if (added.nodeType === 3 && record.target.nodeType === 1 && /(^|\s)hera-/.test(record.target.className)) wrapText(record.target);
      }
    }
  });

  observer.observe(doc.documentElement, { childList: true, subtree: true });
  scan(doc.documentElement);
})();
