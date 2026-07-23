/* Global player-card overlay: click any player name and their full card peeks
   over the current page instead of navigating away. Reuses the real card via
   an embedded iframe (player.html?...&embed=1) -- zero duplication.

   - top-level page: a player link / goPlayer() opens the overlay (modifier-
     clicks and new-tab still navigate normally).
   - inside the overlay's iframe: links stay EMBEDDED so drilling from one comp
     to another stays in the overlay; "Open full page" escapes it.

   window.goPlayer(name) is exposed for row click-handlers that aren't <a>.
   Include on every page with player names: <script src="/player-modal.js"></script>
*/

/* Headshots OFF by default — NHL/Getty player photos are copyrighted, not facts. The
   team-color monogram is the fallback. Set window.IC_HEADSHOTS = true only if image rights
   are secured. Read everywhere a face would render. */
window.IC_HEADSHOTS = window.IC_HEADSHOTS || false;

(function () {
  if (window.__pmInit) return;
  window.__pmInit = true;
  const inIframe = window.self !== window.top;

  function cardQuery(name, id) {
    // ids are collision-proof (two Sebastian Ahos share a name) — prefer them
    return id ? "id=" + encodeURIComponent(id) : "name=" + encodeURIComponent(name);
  }

  function paramsFromLink(a) {
    try {
      const p = new URL(a.href, location.href).searchParams;
      return { name: p.get("name"), id: p.get("id") };
    } catch (e) { return { name: null, id: null }; }
  }

  // resolved below depending on context
  let openModal = (name, id) =>
    (location.href = "player.html?" + cardQuery(name, id) + "&embed=1");

  function goPlayer(name, id) {
    if (!name && !id) return;
    if (inIframe) {
      location.href = "player.html?" + cardQuery(name, id) + "&embed=1";
    } else {
      openModal(name, id);
    }
  }
  window.goPlayer = goPlayer;

  // one delegated handler catches every <a> link to a player card (?name= or ?id=)
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href*="player.html?name="], a[href*="player.html?id="]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank") return;
    const { name, id } = paramsFromLink(a);
    if (!name && !id) return;
    e.preventDefault();
    goPlayer(name, id);
  });

  if (inIframe) return;  // no overlay chrome inside the iframe itself

  const style = document.createElement("style");
  style.textContent =
    ".pm-overlay{position:fixed;inset:0;z-index:1000;background:rgba(5,9,15,.66);display:none;}" +
    ".pm-overlay.open{display:block;}" +
    ".pm-sheet{position:absolute;top:3vh;left:50%;transform:translateX(-50%);" +
      "width:min(1060px,95vw);height:94vh;background:var(--bg,#0b1018);" +
      "border:1px solid var(--line-strong,#2a2d34);border-radius:14px;overflow:hidden;" +
      "box-shadow:0 30px 90px rgba(0,0,0,.6);display:flex;flex-direction:column;}" +
    ".pm-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;" +
      "padding:9px 12px 9px 16px;border-bottom:1px solid var(--line,#1c2230);flex:0 0 auto;}" +
    ".pm-bar .pm-t{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--faint,#5d6b7e);}" +
    ".pm-bar .pm-right{display:flex;align-items:center;gap:12px;}" +
    ".pm-full{color:var(--muted,#9aa0aa);font-size:12.5px;font-weight:600;text-decoration:none;}" +
    ".pm-full:hover{color:var(--ice-bright,#7dd3fc);}" +
    ".pm-close{background:transparent;border:1px solid var(--line,#1c2230);color:var(--muted,#9aa0aa);" +
      "border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:14px;line-height:1;}" +
    ".pm-close:hover{border-color:var(--ice,#38bdf8);color:var(--ice-bright,#7dd3fc);}" +
    ".pm-frame{flex:1 1 auto;border:0;width:100%;background:var(--bg,#0b1018);}" +
    "@media(max-width:680px){.pm-sheet{top:0;height:100vh;width:100vw;border-radius:0;}}";
  document.head.appendChild(style);

  const ov = document.createElement("div");
  ov.className = "pm-overlay";
  ov.innerHTML =
    '<div class="pm-sheet" role="dialog" aria-modal="true" aria-label="Player card">' +
      '<div class="pm-bar"><span class="pm-t">Player card</span>' +
        '<span class="pm-right"><a class="pm-full" target="_blank" rel="noopener">Open full page ↗</a>' +
        '<button class="pm-close" aria-label="Close">✕</button></span></div>' +
      '<iframe class="pm-frame" title="Player card" referrerpolicy="no-referrer"></iframe>' +
    "</div>";
  document.body.appendChild(ov);
  const frame = ov.querySelector(".pm-frame");
  const full = ov.querySelector(".pm-full");

  openModal = function (name, id) {
    const q = cardQuery(name, id);
    frame.src = "player.html?" + q + "&embed=1";
    full.href = "player.html?" + q;
    ov.classList.add("open");
    document.documentElement.style.overflow = "hidden";
  };
  function close() {
    ov.classList.remove("open");
    frame.src = "about:blank";
    document.documentElement.style.overflow = "";
  }
  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target.closest(".pm-close")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ov.classList.contains("open")) close();
  });
})();

/* On phones the page nav collapses to a single horizontal-scroll strip
   (see styles.css). Center the ACTIVE item (the current page — the one
   <span> among the nav's <a>s) so you can see where you are without
   swiping. Pure nav-local scroll: never moves the page. No-op on desktop
   (where the nav fits and doesn't scroll). */
(function () {
  if (window.self !== window.top) return;            // skip inside the card overlay iframe
  function centerActiveNav() {
    const nav = document.querySelector(
      ".pc-top > nav, .ld-top > nav, .fo-head > nav, .rel-head > nav");
    if (!nav || nav.scrollWidth <= nav.clientWidth + 2) return;   // not scrolling → nothing to do
    const active = nav.querySelector(":scope > span");
    if (!active) return;
    const nr = nav.getBoundingClientRect(), ar = active.getBoundingClientRect();
    nav.scrollLeft += (ar.left - nr.left) - (nav.clientWidth - ar.width) / 2;
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", centerActiveNav);
  else centerActiveNav();
})();

/* Site-wide freshness stamp: read api/status.json (written by the bake) and show
   "data built X" so stale data is visible, not silent. Top-level pages only;
   graceful no-op if the file is absent (e.g. the live dev server). */
(function () {
  if (window.self !== window.top) return;
  // The DISCLAIMER renders unconditionally (legal coverage must not depend on a fetch);
  // the freshness stamp fills in above it when api/status.json loads.
  var d = document.createElement("div");
  d.style.cssText = "text-align:center; padding:16px 12px 28px; color:var(--faint,#5d6b7e); font-size:11px; line-height:1.7;";
  d.innerHTML =
    '<div id="ic-fresh"></div>' +
    '<div style="max-width:640px; margin:4px auto 0;">Independent project — not affiliated with or endorsed by the ' +
    'NHL, the NHLPA, or any team. Player names and statistics are used factually; all figures are estimates. ' +
    '<a href="reliability.html" style="color:var(--faint,#5d6b7e); text-decoration:underline;">data &amp; methods</a></div>';
  document.body.appendChild(d);
  fetch("api/status.json").then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
    if (!s || !s.built) return;
    var bits = [];
    if (s.gamesThrough) bits.push("Games through " + s.gamesThrough);
    if (s.latestTransaction) bits.push("Transactions through " + s.latestTransaction);
    bits.push("built " + String(s.built).slice(0, 10));
    var f = document.getElementById("ic-fresh");
    if (f) f.textContent = "Icenomics · " + bits.join(" · ");
  }).catch(function () {});
})();
