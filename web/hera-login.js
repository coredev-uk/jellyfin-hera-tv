/*
 * Hera TV: sign-in page. Registers with window.HeraTV (hera-tv.js).
 *
 * Contracts: the page is reordered, not rebuilt, so Jellyfin's handlers keep working. The stock
 * form's id is replaced while Hera is active and restored on strip. Every Jellyfin piece touched
 * is a key in HT.jf (login*). hera-login.css expects `html.hera-signed-out`,
 * which only this module sets; hera-tv.css keys the signed-out chrome off the same class.
 * There is no onView (nobody is signed in), so status goes through kit.report.
 */
(() => {
  "use strict";
  const core = window.HeraTV;
  if (!core?.kit) return;
  const kit = core.kit;
  const { el, icon } = kit;
  const { jf } = core;

  const root = document.documentElement;
  const userId = () => window.ApiClient?.getCurrentUserId?.() || "";
  const CACHE_KEY = "hera-login";
  const FORM_ID = "heraManualLogin";
  const PENDING_MS = 3000; // how long the form waits for the server before it shows anyway

  /** The server's name and whether the sign-in disclaimer carries a single sign-on link, from the last visit. */
  const readCache = () => {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    } catch {
      return {};
    }
  };
  const writeCache = (value) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(value));
    } catch {
      /* private mode: the page just waits for the network */
    }
  };

  const publicJSON = async (path) => {
    const response = await fetch(new URL(`../${path}`, document.baseURI), { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  };

  let login = null;
  let stockFormId = null; // the sign-in form's own id (if it has one), given back when Hera lets go
  const scope = kit.scope();

  /* ---- Quick Connect dialog: the code, large, with what to do with it ------------------ */

  const enhanceQuickConnect = (dialog) => {
    if (dialog.dataset.heraQuick) return;
    const text = kit.jf("login", "loginDialogText", dialog);
    const code = text?.textContent.match(/\d[\d\s]{3,}\d/)?.[0].replace(/\s+/g, "");
    if (!text || !code) return;
    dialog.dataset.heraQuick = "1";
    const grouped = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
    text.replaceChildren(
      el("div", { class: "hera-qc__code", role: "text", "aria-label": `Code ${code.split("").join(" ")}`, text: grouped }),
      el("p", { class: "hera-qc__hint", text: "Open Quick Connect on a device that is already signed in, and enter this code." }),
    );
  };

  // Dialogs Jellyfin opens while nobody is signed in: Quick Connect, and alerts such as a failed sign-in.
  const watchDialogs = () => {
    const seen = (node) => {
      if (!(node instanceof HTMLElement) || !root.classList.contains("hera-signed-out")) return;
      const dialog = node.matches(jf.loginDialog) ? node : node.querySelector?.(jf.loginDialog);
      if (!dialog) return;
      dialog.classList.add("hera-auth-dialog");
      if (dialog.matches(jf.loginQuickDialog)) enhanceQuickConnect(dialog);
    };
    const observer = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(seen)));
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  };
  scope.add(watchDialogs());

  /** Gives the page back to Jellyfin as it drew it: our classes, additions and form id go, its elements stay. */
  const strip = (page) => {
    page.querySelectorAll(".hera-login__brand, .hera-login__toggle").forEach((n) => n.remove());
    page.querySelectorAll(".hera-login__stock-title").forEach((n) => n.classList.remove("hera-login__stock-title"));
    const form = page.querySelector(jf.loginForm);
    if (form?.id === FORM_ID) {
      if (stockFormId === null) form.removeAttribute("id");
      else form.id = stockFormId;
    }
    page.querySelector(jf.loginStack)?.classList.remove("hera-login__stack");
    page.classList.remove("hera-login", "hera-login--pending", "hera-login--sso", "hera-login--users", "hera-login--form", "hera-login--open");
  };

  /* ---- The sign-in page ------------------------------------------------------------- */

  const build = (page) => {
    const stack = kit.jf("login", "loginStack", page);
    const form = kit.jf("login", "loginForm", page);
    const visual = kit.jf("login", "loginUsers", page);
    const actions = kit.jf("login", "loginActions", page);
    if (!stack || !form || !visual || !actions) return null;

    const cached = readCache();
    const state = {
      page,
      name: cached.name || "",
      sso: cached.sso ?? null, // null until we know whether there is a single sign-on button to lead with
      open: false,
      users: false,
      stopped: false,
      stuck: false, // the password control cannot be reached, so the form shows instead of hiding behind it
    };

    const name = el("h1", { class: "hera-login__name", text: state.name });
    const brand = el("header", { class: "hera-login__brand" }, [
      name,
      el("p", { class: "hera-login__lede", text: "Sign in to start watching" }),
    ]);
    page.querySelectorAll(".hera-login__brand, .hera-login__toggle").forEach((n) => n.remove());
    stack.classList.add("hera-login__stack");
    stack.prepend(brand);

    // One column in reading order, so Tab and the remote's arrows meet the single sign-on button
    // first, then Quick Connect, then the password route. Jellyfin finds every one of these
    // elements through the page, so moving them keeps its handlers.
    if (form.id !== FORM_ID) stockFormId = form.getAttribute("id");
    form.id = FORM_ID;
    // Jellyfin's own heading above the fields gives way to the server's name; only a heading, never a field.
    const heading = form.firstElementChild;
    if (heading && !heading.querySelector("input, button, a")) heading.classList.add("hera-login__stock-title");
    const disclaimer = kit.jf("login", "loginDisclaimer", page);
    if (disclaimer) actions.prepend(disclaimer);
    form.before(actions);

    const toggle = el(
      "button",
      { type: "button", class: "hera-login__toggle", "aria-expanded": "false", "aria-controls": FORM_ID },
      [el("span", { text: "Sign in with a password" }), icon("expand_more")],
    );
    const quick = kit.jf("login", "loginQuick", actions);
    if (quick) quick.after(toggle);
    else actions.append(toggle);

    // Forgotten passwords only matter once the password form is open: it lives inside it.
    const forgot = kit.jf("login", "loginForgot", actions);
    const submit = kit.jf("login", "loginSubmit", form);
    if (forgot && submit) {
      forgot.classList.add("hera-login__quiet");
      submit.after(forgot);
    }
    kit.jfAll("login", "loginSelectServer", page).forEach((b) => b.classList.add("hera-login__quiet"));

    const field = () => kit.jf("login", "loginUsername", form);

    const render = () => {
      const bare = state.sso === false;
      page.classList.add("hera-login");
      page.classList.toggle("hera-login--pending", state.sso === null);
      page.classList.toggle("hera-login--sso", state.sso === true);
      page.classList.toggle("hera-login--users", state.users);
      page.classList.toggle("hera-login--form", state.open || bare || state.users || state.stuck);
      page.classList.toggle("hera-login--open", state.open);
      toggle.setAttribute("aria-expanded", String(state.open));
    };

    const setOpen = (open, focus) => {
      state.open = open;
      render();
      if (open && focus) requestAnimationFrame(() => field()?.focus());
      if (!open) {
        const password = kit.jf("login", "loginPassword", form);
        if (password) password.value = "";
        if (focus) toggle.focus();
      }
    };

    const onToggle = () => setOpen(!state.open, true);
    const onKey = (event) => {
      if (event.key !== "Escape" || !state.open || state.sso !== true) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false, true);
    };
    toggle.addEventListener("click", onToggle);
    form.addEventListener("keydown", onKey);

    // A server that lists its users shows cards; Jellyfin swaps the form in and out itself.
    const syncUsers = () => {
      state.users = !visual.matches(jf.loginHidden);
      render();
    };
    const usersObserver = new MutationObserver(syncUsers);
    usersObserver.observe(visual, { attributes: true, attributeFilter: ["class"] });
    syncUsers();

    // The remote needs something to move from: HyperionID leads. Jellyfin draws that button
    // after its own request for the branding, so wait for it.
    let focused = false;
    const focusLead = () => {
      if (focused || state.stopped || !kit.isTv()) return;
      const lead = kit.jf("login", "loginSso", actions);
      if (!lead || state.sso === null) return;
      focused = true;
      if (!document.activeElement?.matches?.("input")) lead.focus({ preventScroll: true });
    };
    const disclaimerObserver = new MutationObserver(focusLead);
    const disclaimerBox = kit.jf("login", "loginDisclaimerBox", page);
    if (disclaimerBox) disclaimerObserver.observe(disclaimerBox, { childList: true });

    // Neither lookup is certain to answer, and a form that never appears would lock everyone out.
    // Once the timer has shown the form it stays open, so a late answer naming single sign-on
    // can't hide it while someone is typing.
    const pendingTimer = setTimeout(() => {
      if (state.stopped || state.sso !== null) return;
      state.sso = false;
      state.open = true;
      render();
    }, PENDING_MS);

    // The password form hides behind the control above it; if that control cannot be seen, the form shows instead.
    const verifyReachable = () => {
      setTimeout(() => {
        if (state.stopped || state.open || state.users || state.sso !== true || page.getClientRects().length === 0) return;
        if (toggle.getClientRects().length) return;
        state.stuck = true;
        render();
      }, 600);
    };

    kit.track("login", Promise.allSettled([publicJSON("System/Info/Public"), publicJSON("Branding/Configuration")])).then(([info, branding]) => {
      clearTimeout(pendingTimer);
      if (state.stopped) return;
      if (info.status === "fulfilled" && info.value?.ServerName) state.name = info.value.ServerName;
      // With no single sign-on button the password form is the only way in: show it. A failed
      // lookup is not cached, so one hiccup does not decide the next visit.
      if (branding.status === "fulfilled") {
        state.sso = /<(button|a)[\s>]/i.test(branding.value?.LoginDisclaimer || "");
        writeCache({ name: state.name, sso: state.sso });
      } else if (state.sso === null) {
        state.sso = false;
      }
      name.textContent = state.name || "Sign in";
      render();
      focusLead();
      verifyReachable();
    });

    render();
    verifyReachable();

    return {
      page,
      reset() {
        setOpen(false, false);
      },
      destroy() {
        state.stopped = true;
        clearTimeout(pendingTimer);
        toggle.removeEventListener("click", onToggle);
        form.removeEventListener("keydown", onKey);
        usersObserver.disconnect();
        disclaimerObserver.disconnect();
        const password = kit.jf("login", "loginPassword", form);
        if (password) password.value = "";
        strip(page);
      },
    };
  };

  /** The forgot-password, reset, add-server and select-server pages: signed-out standalone pages. */
  let authPage = null;
  const markAuth = (page) => {
    if (authPage === page) return;
    authPage?.classList.remove("hera-auth");
    authPage = page;
    authPage?.classList.add("hera-auth");
  };

  const leave = () => {
    stopWaiting();
    login?.destroy();
    login = null;
    kit.report("login", "idle");
  };

  // Waiting for pieces is expected to miss for a moment, so this reads the registry's selectors
  // directly; only the verdict after the settle wait is reported.
  const missingPieces = (page) => ["loginStack", "loginForm", "loginUsers", "loginActions"].filter((key) => !page.querySelector(jf[key]));

  const tryBuild = (page) => {
    try {
      login = build(page);
      if (login) kit.report("login", "ok");
      else kit.report("login", "degraded", "Jellyfin's sign-in page changed while it was being drawn");
    } catch (error) {
      // Half-moved elements go back; Jellyfin's page is what stays.
      console.error("[Hera TV:login]", error);
      strip(page);
      login = null;
      kit.report("login", "degraded", String(error?.message || error));
    }
  };

  // Jellyfin draws the sign-in page in pieces. Wait a moment for them; if one never comes, the
  // stock page stands, untouched. Nobody is signed in, so the report is the only one to tell.
  const waiting = { observer: null, timer: 0 };
  function stopWaiting() {
    waiting.observer?.disconnect();
    waiting.observer = null;
    clearTimeout(waiting.timer);
  }
  const mountLogin = (page) => {
    stopWaiting();
    if (!missingPieces(page).length) return tryBuild(page);
    const attempt = () => {
      if (missingPieces(page).length) return;
      stopWaiting();
      tryBuild(page);
    };
    waiting.observer = new MutationObserver(attempt);
    waiting.observer.observe(page, { childList: true, subtree: true });
    waiting.timer = setTimeout(() => {
      const gone = missingPieces(page);
      stopWaiting();
      if (!gone.length) return tryBuild(page);
      const detail = `Jellyfin's sign-in page has no ${gone.map((key) => jf[key]).join(", ")}`;
      console.warn(`[Hera TV:login] standing aside: ${detail}`);
      kit.report("login", "degraded", detail);
    }, kit.settleMs);
  };

  const show = (page) => {
    const isLogin = !!page?.matches(jf.loginPage);
    const signedOut = !!page?.matches(jf.loginStandalone) && (isLogin || !userId());
    root.classList.toggle("hera-signed-out", signedOut);
    markAuth(signedOut && !isLogin ? page : null);
    if (!isLogin) return leave();
    if (login?.page === page) return login.reset();
    leave();
    mountLogin(page);
  };

  core.register({
    name: "login",
    // Everything that touches Jellyfin's sign-in page waits for start(): a module switched off in
    // the plugin's settings must not rebuild the form.
    start() {
      scope.add(kit.onRoute("login", ({ page }) => show(page)));
      // The page may already be showing when this script arrives.
      show(kit.jf("login", "page"));
    },
    teardown() {
      leave();
      root.classList.remove("hera-signed-out");
      markAuth(null);
      scope.dispose();
    },
  });
})();
