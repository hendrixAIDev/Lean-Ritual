// Runs before first paint: pick the language the same way login.html does
// (?lang=, then the saved bj-lang choice, then the browser language, then zh),
// mark that JS is on so reveal animations can start hidden, and send an
// installed home-screen app straight to sign-in instead of the landing page.
(function () {
  "use strict";
  var root = document.documentElement;
  var read = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var write = function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: choice lasts this visit only */ } };
  var valid = function (v) { v = typeof v === "string" ? v.trim().toLowerCase() : ""; return v === "zh" || v === "en" ? v : null; };
  try {
    if (window.matchMedia && matchMedia("(display-mode: standalone)").matches) { location.replace("/login.html"); return; }
  } catch (e) { /* matchMedia unsupported: stay on the landing page */ }
  var query = null;
  try { query = valid(new URLSearchParams(location.search).get("lang")); } catch (e) { query = null; }
  if (query) { write("bj-lang", query); write("bj-lang-set-at", String(Date.now())); write("bj-lang-pending", query); }
  var browser = function () {
    var nav = window.navigator || {};
    var list = nav.languages && nav.languages.length ? nav.languages : (typeof nav.language === "string" && nav.language.trim() ? [nav.language] : []);
    if (!list.length) return "zh";
    for (var i = 0; i < list.length; i++) if (String(list[i] || "").trim().toLowerCase().indexOf("zh") === 0) return "zh";
    return "en";
  };
  var lang = query || valid(read("bj-lang")) || browser();
  root.setAttribute("data-lang", lang);
  if (root.classList) root.classList.add("js"); else root.className += " js";
  if (lang === "en") {
    root.lang = "en";
    root.setAttribute("data-i18n-pending", "");
    // Never leave the page hidden if landing.js fails to load.
    setTimeout(function () { root.removeAttribute("data-i18n-pending"); }, 1500);
  }
})();
