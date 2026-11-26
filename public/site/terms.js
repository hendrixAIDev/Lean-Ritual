(function(){
  const validLang = v => typeof v === "string" && (v.trim().toLowerCase() === "zh" || v.trim().toLowerCase() === "en") ? v.trim().toLowerCase() : null;
  const lsRead = k => { try { return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null; } catch { return null; } };
  const lsWrite = (k, v) => { try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); } catch {} };
  function markExplicitLang(l){
    lsWrite("bj-lang", l);
    lsWrite("bj-lang-set-at", String(Date.now()));
    lsWrite("bj-lang-pending", l);
  }
  function detectBrowserLang(nav){
    const list = Array.isArray(nav?.languages) && nav.languages.length ? nav.languages : (typeof nav?.language === "string" && nav.language.trim() ? [nav.language] : []);
    if (!list.length) return "zh";
    return list.some(l => String(l || "").trim().toLowerCase().startsWith("zh")) ? "zh" : "en";
  }
  function queryLang(search){
    const s = String(search || "").replace(/^\?/, "");
    if (!s) return null;
    for (const part of s.split("&")) {
      const eq = part.indexOf("=");
      const k = eq < 0 ? part : part.slice(0, eq);
      if (k === "lang") {
        try { return validLang(decodeURIComponent(eq < 0 ? "" : part.slice(eq + 1))); } catch { return null; }
      }
    }
    return null;
  }
  function resolveLang({ search = "", savedLang = null, nav = null } = {}){
    const q = queryLang(search);
    if (q) return q;
    return validLang(savedLang) || detectBrowserLang(nav);
  }
  const META = {
    zh: { title: "使用条款 · Lean Ritual", back: "返回应用", aria: "语言" },
    en: { title: "Terms of Use · Lean Ritual", back: "‹ Back to app", aria: "Language" }
  };
  const root = document.querySelector("#doc-root"), zhDoc = document.querySelector("#doc-zh"), enDoc = document.querySelector("#doc-en");
  const backLink = document.querySelector("#back-link"), lsw = document.querySelector("#lang-switch");
  const qLang = queryLang(location.search || "");
  if (qLang) markExplicitLang(qLang);
  let curLang = resolveLang({ search: location.search || "", savedLang: lsRead("bj-lang"), nav: typeof navigator !== "undefined" ? navigator : null });
  function applyLangUI(){
    const m = META[curLang] || META.zh;
    if (document.documentElement) document.documentElement.lang = curLang === "en" ? "en" : "zh-CN";
    if ("title" in document) document.title = m.title;
    const appTitleMeta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (appTitleMeta) appTitleMeta.content = curLang === "en" ? "Lean Ritual" : "薄肌日课";
    if (backLink) backLink.textContent = m.back;
    if (lsw && lsw.setAttribute) lsw.setAttribute("aria-label", m.aria);
    if (document.querySelectorAll) document.querySelectorAll("#lang-switch button").forEach(b => b.classList.toggle("on", b.dataset.lang === curLang));
    const active = curLang === "en" ? enDoc : zhDoc, inactive = curLang === "en" ? zhDoc : enDoc;
    if (inactive) { inactive.hidden = true; if (inactive.parentNode) inactive.parentNode.removeChild(inactive); }
    if (active) { active.hidden = false; if (!active.parentNode && root) root.appendChild(active); }
  }
  function setLang(next){
    const l = validLang(next);
    if (!l) return;
    curLang = l;
    markExplicitLang(l);
    applyLangUI();
  }
  if (lsw) lsw.onclick = e => { const b = e.target.closest("button"); if (b && b.dataset.lang) setLang(b.dataset.lang); };
  applyLangUI();
  if (typeof window !== "undefined") window.ritualPageI18n = { getLang: () => curLang, setLang, resolveLang, detectBrowserLang };
})();
