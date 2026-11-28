/*
 * The browser APIs that Hera's scripts use and Chromium before 86 lacks, which core-js (language
 * built-ins only) doesn't cover. Each one is added only where it is missing; Chromium 53 (webOS 4)
 * and 63 (Tizen 5) need different ones, and a browser that has the real thing never runs the
 * stand-in. Plain ES5: it is the first thing the legacy bundle runs and no transpiler has seen it.
 */
(function () {
  "use strict";

  var win = window;
  var doc = document;

  var define = function (target, name, value) {
    if (target && !(name in target)) Object.defineProperty(target, name, { value: value, writable: true, configurable: true });
  };

  var abortError = function () {
    try {
      return new DOMException("The operation was aborted.", "AbortError");
    } catch (e) {
      var error = new Error("The operation was aborted.");
      error.name = "AbortError";
      return error;
    }
  };

  // ---------- ChildNode and ParentNode (Chromium 54; replaceChildren 86) ----------

  var toNode = function (list) {
    var fragment = doc.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      fragment.appendChild(list[i] instanceof Node ? list[i] : doc.createTextNode(String(list[i])));
    }
    return fragment;
  };

  // The sibling to insert before once the nodes being inserted have left the tree.
  var viable = function (sibling, list, step) {
    while (sibling && Array.prototype.indexOf.call(list, sibling) >= 0) sibling = sibling[step];
    return sibling;
  };

  var parentNode = {
    append: function () {
      this.appendChild(toNode(arguments));
    },
    prepend: function () {
      var first = this.firstChild;
      this.insertBefore(toNode(arguments), first);
    },
    replaceChildren: function () {
      var fragment = toNode(arguments);
      while (this.firstChild) this.removeChild(this.firstChild);
      this.appendChild(fragment);
    },
  };

  var childNode = {
    before: function () {
      var parent = this.parentNode;
      if (!parent) return;
      var sibling = viable(this.previousSibling, arguments, "previousSibling");
      var fragment = toNode(arguments);
      parent.insertBefore(fragment, sibling ? sibling.nextSibling : parent.firstChild);
    },
    after: function () {
      var parent = this.parentNode;
      if (!parent) return;
      var sibling = viable(this.nextSibling, arguments, "nextSibling");
      parent.insertBefore(toNode(arguments), sibling);
    },
    replaceWith: function () {
      var parent = this.parentNode;
      if (!parent) return;
      var sibling = viable(this.nextSibling, arguments, "nextSibling");
      var fragment = toNode(arguments);
      if (this.parentNode === parent) parent.replaceChild(fragment, this);
      else parent.insertBefore(fragment, sibling);
    },
  };

  [win.Element, win.Document, win.DocumentFragment].forEach(function (type) {
    if (!type) return;
    Object.keys(parentNode).forEach(function (name) {
      define(type.prototype, name, parentNode[name]);
    });
  });
  [win.Element, win.CharacterData, win.DocumentType].forEach(function (type) {
    if (!type) return;
    Object.keys(childNode).forEach(function (name) {
      define(type.prototype, name, childNode[name]);
    });
  });

  // ---------- Element (toggleAttribute 69; scrolling methods 61) ----------

  define(win.Element.prototype, "toggleAttribute", function (name, force) {
    var has = this.hasAttribute(name);
    if (force === undefined ? has : !force) {
      this.removeAttribute(name);
      return false;
    }
    if (!has) this.setAttribute(name, "");
    return true;
  });

  // Behaviour (smooth) is ignored where it is not understood; the position is what matters.
  var position = function (element, x, y, relative) {
    var left = element.scrollLeft;
    var top = element.scrollTop;
    var options = x;
    if (options !== null && typeof options === "object") {
      x = options.left;
      y = options.top;
    }
    if (x !== undefined && x !== null) element.scrollLeft = relative ? left + Number(x) : Number(x);
    if (y !== undefined && y !== null) element.scrollTop = relative ? top + Number(y) : Number(y);
  };
  define(win.Element.prototype, "scrollTo", function (x, y) {
    position(this, x, y, false);
  });
  define(win.Element.prototype, "scroll", function (x, y) {
    position(this, x, y, false);
  });
  define(win.Element.prototype, "scrollBy", function (x, y) {
    position(this, x, y, true);
  });

  // scrollIntoView({ block }) before Chromium 61 reads the object as `true` and aligns to the top.
  var readsOptions = false;
  try {
    doc.createElement("div").scrollIntoView({
      get block() {
        readsOptions = true;
        return "nearest";
      },
    });
  } catch (e) {
    readsOptions = true;
  }
  if (!readsOptions) {
    var scrollIntoView = win.Element.prototype.scrollIntoView;
    win.Element.prototype.scrollIntoView = function (arg) {
      if (arg === null || typeof arg !== "object") return scrollIntoView.apply(this, arguments);
      var block = arg.block || "start";
      if ((block === "nearest" || block === "center") && this.scrollIntoViewIfNeeded) return this.scrollIntoViewIfNeeded(block === "center");
      return scrollIntoView.call(this, block !== "end");
    };
  }

  // ---------- focus({ preventScroll }) (Chromium 64): focus, then put every scroll position back ----------

  var readsPreventScroll = false;
  try {
    doc.createElement("button").focus({
      get preventScroll() {
        readsPreventScroll = true;
        return true;
      },
    });
  } catch (e) {
    readsPreventScroll = true;
  }
  if (!readsPreventScroll && win.HTMLElement) {
    var focus = win.HTMLElement.prototype.focus;
    win.HTMLElement.prototype.focus = function (options) {
      if (!options || !options.preventScroll) return focus.apply(this, arguments);
      var saved = [];
      for (var node = this.parentNode; node && node.nodeType === 1; node = node.parentNode) {
        saved.push([node, node.scrollLeft, node.scrollTop]);
      }
      var x = win.pageXOffset;
      var y = win.pageYOffset;
      focus.call(this);
      saved.forEach(function (entry) {
        if (entry[0].scrollLeft !== entry[1]) entry[0].scrollLeft = entry[1];
        if (entry[0].scrollTop !== entry[2]) entry[0].scrollTop = entry[2];
      });
      if (win.pageXOffset !== x || win.pageYOffset !== y) win.scrollTo(x, y);
    };
  }

  // ---------- HTMLImageElement.decode (64) ----------

  if (win.HTMLImageElement) {
    define(win.HTMLImageElement.prototype, "decode", function () {
      var image = this;
      return new Promise(function (resolve, reject) {
        var fail = function () {
          var error = new Error("The source image cannot be decoded.");
          error.name = "EncodingError";
          reject(error);
        };
        if (image.complete) {
          if (image.naturalWidth > 0) resolve();
          else fail();
          return;
        }
        var done = function (ok) {
          image.removeEventListener("load", onLoad);
          image.removeEventListener("error", onError);
          if (ok) resolve();
          else fail();
        };
        var onLoad = function () {
          done(true);
        };
        var onError = function () {
          done(false);
        };
        image.addEventListener("load", onLoad);
        image.addEventListener("error", onError);
      });
    });
  }

  // ---------- IntersectionObserverEntry.isIntersecting (58) ----------

  if (win.IntersectionObserverEntry && !("isIntersecting" in win.IntersectionObserverEntry.prototype)) {
    Object.defineProperty(win.IntersectionObserverEntry.prototype, "isIntersecting", {
      configurable: true,
      get: function () {
        return this.intersectionRatio > 0;
      },
    });
  }

  // ---------- PointerEvent (55): the constructor, and pointer events made from the mouse's ----------

  if (!win.PointerEvent) {
    var PointerEvent = function (type, init) {
      init = init || {};
      var event = new MouseEvent(type, init);
      Object.defineProperties(event, {
        pointerId: { value: init.pointerId === undefined ? 1 : init.pointerId },
        width: { value: init.width === undefined ? 1 : init.width },
        height: { value: init.height === undefined ? 1 : init.height },
        pressure: { value: init.pressure === undefined ? 0 : init.pressure },
        pointerType: { value: init.pointerType === undefined ? "mouse" : init.pointerType },
        isPrimary: { value: init.isPrimary === undefined ? true : init.isPrimary },
      });
      return event;
    };
    PointerEvent.prototype = MouseEvent.prototype;
    win.PointerEvent = PointerEvent;

    var mirror = function (source, type, target, bubbles) {
      var init = {
        bubbles: bubbles,
        cancelable: bubbles,
        view: source.view,
        detail: source.detail,
        screenX: source.screenX,
        screenY: source.screenY,
        clientX: source.clientX,
        clientY: source.clientY,
        ctrlKey: source.ctrlKey,
        shiftKey: source.shiftKey,
        altKey: source.altKey,
        metaKey: source.metaKey,
        button: source.button,
        buttons: source.buttons,
        relatedTarget: source.relatedTarget,
      };
      target.dispatchEvent(new PointerEvent(type, init));
    };

    // The nodes the pointer enters (or leaves) on its way from `from` to `to`, innermost first.
    var crossed = function (from, to) {
      var nodes = [];
      for (var node = from; node && node.nodeType === 1; node = node.parentNode) {
        if (to && node.contains(to)) break;
        nodes.push(node);
      }
      return nodes;
    };

    var forwarded = { mousedown: "pointerdown", mouseup: "pointerup", mousemove: "pointermove", mouseover: "pointerover", mouseout: "pointerout" };
    Object.keys(forwarded).forEach(function (type) {
      doc.addEventListener(
        type,
        function (event) {
          if (!event.target || event.target.nodeType !== 1) return;
          mirror(event, forwarded[type], event.target, true);
          if (type === "mouseover") {
            crossed(event.target, event.relatedTarget)
              .reverse()
              .forEach(function (node) {
                mirror(event, "pointerenter", node, false);
              });
          } else if (type === "mouseout") {
            crossed(event.target, event.relatedTarget).forEach(function (node) {
              mirror(event, "pointerleave", node, false);
            });
          }
        },
        true,
      );
    });
  }

  // ---------- URLSearchParams from an object or a list of pairs (61) ----------

  var Params = win.URLSearchParams;
  if (Params && new Params({ a: "1" }).toString() !== "a=1") {
    var Stand = function (init) {
      var params = new Params();
      var kind = Object.prototype.toString.call(init);
      if (kind === "[object Object]") {
        Object.keys(init).forEach(function (key) {
          params.append(key, init[key]);
        });
      } else if (kind === "[object Array]") {
        init.forEach(function (pair) {
          params.append(pair[0], pair[1]);
        });
      } else if (init !== undefined) {
        // A string, or another URLSearchParams, which the native constructor reads.
        params = new Params(init);
      }
      return params;
    };
    Stand.prototype = Params.prototype;
    win.URLSearchParams = Stand;
  }

  // ---------- AbortController, AbortSignal (66) and fetch's use of one ----------

  if (!win.AbortController) {
    var AbortSignal = function () {
      throw new TypeError("Illegal constructor");
    };
    var newSignal = function () {
      var signal = Object.create(AbortSignal.prototype);
      signal.aborted = false;
      signal.reason = undefined;
      signal.onabort = null;
      Object.defineProperty(signal, "listeners", { value: [] });
      return signal;
    };
    var fire = function (signal) {
      var event = { type: "abort", target: signal, currentTarget: signal };
      if (typeof signal.onabort === "function") signal.onabort(event);
      signal.listeners.slice().forEach(function (entry) {
        if (entry.once) signal.removeEventListener("abort", entry.listener);
        entry.listener.call(signal, event);
      });
    };
    var abort = function (signal, reason) {
      if (signal.aborted) return;
      signal.aborted = true;
      signal.reason = reason === undefined ? abortError() : reason;
      fire(signal);
    };
    AbortSignal.prototype = {
      constructor: AbortSignal,
      addEventListener: function (type, listener, options) {
        if (type !== "abort" || typeof listener !== "function") return;
        var once = options !== null && typeof options === "object" && !!options.once;
        this.listeners.push({ listener: listener, once: once });
      },
      removeEventListener: function (type, listener) {
        if (type !== "abort") return;
        for (var i = this.listeners.length - 1; i >= 0; i--) {
          if (this.listeners[i].listener === listener) this.listeners.splice(i, 1);
        }
      },
      dispatchEvent: function () {
        fire(this);
        return true;
      },
      throwIfAborted: function () {
        if (this.aborted) throw this.reason;
      },
    };
    AbortSignal.abort = function (reason) {
      var signal = newSignal();
      abort(signal, reason);
      return signal;
    };
    AbortSignal.timeout = function (ms) {
      var signal = newSignal();
      setTimeout(function () {
        var reason;
        try {
          reason = new DOMException("The operation timed out.", "TimeoutError");
        } catch (e) {
          reason = new Error("The operation timed out.");
          reason.name = "TimeoutError";
        }
        abort(signal, reason);
      }, ms);
      return signal;
    };
    var AbortController = function () {
      Object.defineProperty(this, "signal", { value: newSignal(), enumerable: true });
    };
    AbortController.prototype.abort = function (reason) {
      abort(this.signal, reason);
    };
    win.AbortSignal = AbortSignal;
    win.AbortController = AbortController;

    // The browser's fetch takes no signal, so one is raced against it. The request itself runs on.
    var nativeFetch = win.fetch;
    if (nativeFetch) {
      win.fetch = function (input, init) {
        var signal = (init && init.signal) || (input && typeof input === "object" && input.signal);
        if (!signal || typeof signal.addEventListener !== "function") return nativeFetch.apply(this, arguments);
        if (signal.aborted) return Promise.reject(signal.reason);
        var args = arguments;
        return new Promise(function (resolve, reject) {
          var onAbort = function () {
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort);
          nativeFetch.apply(win, args).then(
            function (response) {
              signal.removeEventListener("abort", onAbort);
              resolve(response);
            },
            function (error) {
              signal.removeEventListener("abort", onAbort);
              reject(error);
            },
          );
        });
      };
    }
  }

  // ---------- ResizeObserver (64): sizes looked at when the window resizes, a transition ends, and once a second ----------

  if (!win.ResizeObserver) {
    var observers = [];
    var timer = 0;

    var check = function () {
      observers.slice().forEach(function (observer) {
        var entries = [];
        observer.records.slice().forEach(function (record) {
          var rect = record.target.getBoundingClientRect();
          if (rect.width === record.width && rect.height === record.height) return;
          record.width = rect.width;
          record.height = rect.height;
          entries.push({
            target: record.target,
            contentRect: { x: 0, y: 0, top: 0, left: 0, width: rect.width, height: rect.height, right: rect.width, bottom: rect.height },
          });
        });
        if (entries.length) observer.callback.call(observer, entries, observer);
      });
    };

    var later = function () {
      (win.requestAnimationFrame || setTimeout)(check);
    };

    var watch = function () {
      if (timer || observers.length === 0) return;
      timer = setInterval(function () {
        if (observers.length === 0) {
          clearInterval(timer);
          timer = 0;
        } else {
          check();
        }
      }, 1000);
    };

    win.addEventListener("resize", later);
    win.addEventListener("load", later);
    doc.addEventListener("transitionend", later, true);
    doc.addEventListener("animationend", later, true);

    var ResizeObserver = function (callback) {
      if (typeof callback !== "function") throw new TypeError("ResizeObserver needs a callback");
      this.callback = callback;
      this.records = [];
    };
    ResizeObserver.prototype.observe = function (target) {
      for (var i = 0; i < this.records.length; i++) if (this.records[i].target === target) return;
      // Sizes start at nothing, so the first check reports the element as the real thing does.
      this.records.push({ target: target, width: -1, height: -1 });
      if (observers.indexOf(this) < 0) observers.push(this);
      watch();
      later();
    };
    ResizeObserver.prototype.unobserve = function (target) {
      this.records = this.records.filter(function (record) {
        return record.target !== target;
      });
      if (this.records.length === 0) this.disconnect();
    };
    ResizeObserver.prototype.disconnect = function () {
      this.records = [];
      var at = observers.indexOf(this);
      if (at >= 0) observers.splice(at, 1);
    };
    win.ResizeObserver = ResizeObserver;
  }
})();
