// 独立部署版的"平台层"：给页面提供和 Claude 页面版同样的 window.claude.use(...) 接口，
// 背后改成调用自己服务器的 /api。页面主体代码两边共用一份。
(function () {
  "use strict";
  const H = { "X-Bojin": "1" };
  async function api(method, url, body, rawType, signal) {
    let r;
    try {
      r = await fetch(url, { method, credentials: "same-origin", signal,
        headers: rawType ? { ...H, "Content-Type": rawType } : body !== undefined ? { ...H, "Content-Type": "application/json" } : H,
        body: rawType ? body : body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled" }; throw { code: "network", message: "连不上服务器" }; }
    let j = null; try { j = await r.json(); } catch {}
    if (r.status === 401 && !/\/api\/(login|password)/.test(url)) { location.href = "/login.html"; throw { code: "session_expired" }; }
    if (!r.ok) throw { code: (j && j.error) || "http_" + r.status, message: (j && j.message) || "" };
    return j;
  }
  const enc = encodeURIComponent;
  const doc = p => ({
    id: p.split("/").pop(),
    async get() { const j = await api("GET", "/api/doc?path=" + enc(p)); return { exists: !!j.exists, id: p.split("/").pop(), data: () => j.data }; },
    set: d => api("PUT", "/api/doc?path=" + enc(p), { data: d }),
    update: d => api("PATCH", "/api/doc?path=" + enc(p), { data: d }),
    delete: () => api("DELETE", "/api/doc?path=" + enc(p)),
  });
  const collection = (p, o = {}) => ({
    orderBy: (field, dir) => collection(p, { ...o, order: field, dir: dir || "asc" }),
    limit: n => collection(p, { ...o, limit: n }),
    doc: id => doc(p + "/" + id),
    async get() {
      const q = new URLSearchParams({ col: p }); if (o.order) { q.set("order", o.order); q.set("dir", o.dir); } if (o.limit) q.set("limit", o.limit);
      const j = await api("GET", "/api/list?" + q);
      return { docs: j.docs.map(d => ({ id: d.id, data: () => d.data })), empty: !j.docs.length };
    },
  });
  const db = { doc, collection };

  const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
  async function shrink(blob, max = 1280) {
    try {
      const bmp = await createImageBitmap(blob), k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(b => r(b || blob), "image/jpeg", 0.85));
    } catch { return blob; }
  }
  function parseJSONText(t) {
    t = String(t || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
    try { return JSON.parse(t); } catch {}
    const i = t.search(/[\[{]/), j = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
    throw { code: "invalid_json", message: "回答不是 JSON" };
  }
  const sample = async (input, opts = {}) => {
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : input.map(t => ({ role: t.role, content: String(t.content ?? "") }));
    const images = [];
    for (const b of opts.images || []) if (b) images.push(await blobToDataURL(await shrink(b)));
    const r = await api("POST", "/api/ai", { messages, images }, null, opts.signal);
    if (opts.onText) { try { opts.onText({ text: r.text, delta: r.text }); } catch {} }
    return r;
  };
  sample.json = async (input, opts) => parseJSONText((await sample(input, opts)).text);
  sample.limits = async () => ({ images: { max: 4, mediaTypes: ["image/jpeg", "image/png", "image/webp"] } });

  const assets = {
    async upload(blob, opts = {}) { const type = blob.type || opts.type || "image/jpeg"; return api("POST", "/api/assets", blob, type); },
    delete: id => api("DELETE", "/api/assets/" + enc(id)),
    async list() { return { assets: [], usage: null }; },
  };

  const meP = api("GET", "/api/me").catch(() => null);
  const user = {
    async me() { const m = await meP; return m ? { ...m, isOwner: false, canEdit: false } : null; },
    async id() { return (await meP)?.id || null; },
    isOwner: () => false, canEdit: () => false, can: () => null,
  };

  window.claude = {
    hosted: true,
    async use(name) {
      const m = await meP;
      if (!m) return null;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "assets") return assets;
      if (name === "sample") return m.ai ? sample : null;
      return null;   // comments 等 Claude 专属能力在独立部署版里没有
    },
    changePassword: (oldPw, newPw) => api("POST", "/api/password", { old: oldPw, new: newPw }),
    logout: () => api("POST", "/api/logout"),
  };
})();
