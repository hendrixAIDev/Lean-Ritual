// Landing page behaviour: zh/en copy swap without reload, the intro video when the
// server includes it (fetched only on play), scroll reveals and count-ups.
// boot.js has already chosen the language and set html.js.
(() => {
  "use strict";
  const CONTACT = "hendrix.ai.dev@gmail.com";   // same contact as privacy.html
  const MEDIA = "/media/intro-";                 // stable paths; the files live in MEDIA_DIR on the host
  const I18N = {
    zh: {
      title: "薄肌日课 · 一个 App，助你更瘦、更强、更好", brand: "薄肌日课", brand2: "LEAN RITUAL", "lang.aria": "语言",
      "nav.signin": "登录", beta: "邀请制内测", "h.full": "一个 App，助你更瘦、更强、更好", "h.pre": "一个 App，助你",
      "h.w1": "更瘦", "h.w2": "更强", "h.w3": "更好",
      lede: "训练、饮食、体重，需要的都在这里。计划按你的目标定制，AI 帮你估餐和复盘。",
      "cta.invite": "用邀请码注册", "cta.signin": "登录", "cta.ask": "还没有邀请码？发邮件申请",
      "st1.k": "今天建议", "st2.k": "7 天平均",
      t1: "每天快速打卡", t2: "7 天平均", t3: "今天建议 60 kg", t4: "拍照估热量", t5: "AI 教练复盘", t6: "采纳可撤销", t7: "数据导出",
      "video.t": "看看薄肌日课怎么用", "video.d": "从建档到复盘，一次看完一天怎么用。", "video.play": "播放介绍视频", "video.meta": "中文配音",
      "video.error": "视频暂时无法播放，请稍后再试。",
      "setup.unit": "分钟", "setup.t1": "1 分钟，填好目标和身体状况", "setup.t2": "为你定制，需要时问 AI 教练",
      "setup.d": "训练计划和热量目标按你的资料用公式算出，伤病也会考虑。想调整时，让 AI 教练看看记录，要不要采纳由你决定。",
      "board.note": "界面和数值为示例。", "board.t": "每天的数字，替你说话",
      "f1.unit": "天", "f1.t": "每天快速打卡", "f1.d": "记下体重、步数和睡眠。看 7 天平均，不被每天的起伏干扰。", "f1.chip": "7 天平均 72.7 kg",
      "f2.t": "告诉你今天练多重", "f2.d": "练过的动作，会按上次的记录建议今天的重量。", "f2.chip": "今天建议 60 kg",
      "f3.t": "拍张照，AI 帮你估热量", "f3.d": "吃饭不用称重。拍照或写几句，AI 估算热量和蛋白质，有照片一般 1 分钟左右，结果可以改。", "f3.chip": "540 kcal · 蛋白质 46.5 g",
      "f4.unit": "天", "f4.t": "AI 教练帮你复盘", "f4.d": "卡住了？写一句感受，让 AI 教练看最近 14 天的记录，给你调整建议。", "f4.chip": "可采纳，也可撤销",
      "f5.unit": "类图表", "f5.t": "进步一目了然", "f5.d": "体重、热量和力量的变化，都画成图表。", "f5.chip": "体重 · 热量 · 力量",
      "x1.t": "你的数据，随时带走", "x1.d": "记录和照片，都能导出。", "x2.t": "像 App 一样放在主屏幕", "x2.d": "不用下载安装，浏览器打开就能用。", "x3.d": "中英文随时切换。",
      "ai.t": "AI 帮你做三件事", "ai.1t": "估算一餐", "ai.1d": "看餐食照片或文字，估算热量和蛋白质，结果可以改。", "ai.2t": "推荐替代动作", "ai.2d": "想换动作时，最多推荐 3 个替代，用不用由你定。", "ai.3t": "帮你复盘", "ai.3d": "你提出时，它看最近 14 天的记录给建议，可采纳，也可撤销。",
      "ai.note": "起始的训练计划和热量目标由公式计算，不用 AI。AI 结果仅供参考，不构成医疗建议。",
      "end.t": "更瘦、更强、更好，\n从这里开始", "end.d": "薄肌日课正在邀请制内测。有邀请码就能注册；还没有的话，给我们发封邮件。",
      "foot.aria": "页脚", "foot.privacy": "隐私说明", "foot.terms": "使用条款", "foot.guide": "训练与饮食纲领", "foot.contact": "联系我们", "foot.op": "© 2026 杰瑞智能技术服务部",
      mailSubject: "申请薄肌日课内测邀请", mailBody: "你好，我想申请薄肌日课的内测邀请。\n\n我的称呼：\n想达成的目标：\n",
      "alt.workout": "训练页：按上次记录建议今天的重量"
    },
    en: {
      title: "Lean Ritual · One app to get leaner, stronger, better", brand: "Lean Ritual", brand2: "薄肌日课", "lang.aria": "Language",
      "nav.signin": "Sign in", beta: "Invite-only beta", "h.full": "One app to get leaner, stronger, better", "h.pre": "One app to get",
      "h.w1": "Leaner", "h.w2": "Stronger", "h.w3": "Better",
      lede: "Workouts, meals and weight, all in one place. A plan built around your goal, with AI help for meals and reviews.",
      "cta.invite": "Use your invite", "cta.signin": "Sign in", "cta.ask": "No invite yet? Ask for one",
      "st1.k": "Today", "st2.k": "7-day avg",
      t1: "Quick daily check-in", t2: "7-day average", t3: "Today: 60 kg", t4: "Snap a meal", t5: "AI coach review", t6: "Apply or undo", t7: "Data export",
      "video.t": "See Lean Ritual in action", "video.d": "From setup to coach review: one day with the app.", "video.play": "Play the intro video", "video.meta": "English voiceover",
      "video.error": "The video can't play right now. Please try again later.",
      "setup.unit": "min", "setup.t1": "1 minute: your goal and body", "setup.t2": "Made for you. Ask the AI coach when you need it.",
      "setup.d": "Formulas set your workouts and calorie target from your details, injuries included. Want a change? Ask the AI coach to look at your logs, then decide what to apply.",
      "board.note": "Screens and numbers are examples.", "board.t": "Your day, by the numbers",
      "f1.unit": "days", "f1.t": "Quick daily check-in", "f1.d": "Log weight, steps and sleep. Watch the 7-day average, not the daily ups and downs.", "f1.chip": "7-day avg 72.7 kg",
      "f2.t": "Know what weight to lift", "f2.d": "For lifts you've logged, it suggests today's weight from your last session.", "f2.chip": "Today: 60 kg",
      "f3.t": "Snap a photo, AI estimates it", "f3.d": "No scales. From a photo or a few words, AI estimates calories and protein. Photos usually take about a minute, and you can edit the result.", "f3.chip": "540 kcal · 46.5 g protein",
      "f4.unit": "days", "f4.t": "Ask your AI coach", "f4.d": "Stuck? Write one line and ask your AI coach to review your last 14 days and suggest changes.", "f4.chip": "Apply or undo",
      "f5.unit": "charts", "f5.t": "See your progress", "f5.d": "Weight, calories and strength, all in clear charts.", "f5.chip": "Weight · Calories · Strength",
      "x1.t": "Your data, yours to keep", "x1.d": "Export your records and photos.", "x2.t": "On your home screen", "x2.d": "Nothing to install. It opens right in your browser.", "x3.d": "Switch languages anytime.",
      "ai.t": "Three things AI helps with", "ai.1t": "Estimates a meal", "ai.1d": "Calories and protein from a photo or a few words. You can edit the result.", "ai.2t": "Suggests exercise swaps", "ai.2d": "Want a different exercise? Get up to 3 options and pick one, or none.", "ai.3t": "Reviews your last 14 days", "ai.3d": "When you ask, it suggests changes you can apply or undo.",
      "ai.note": "Your starting workouts and calorie target come from formulas, not AI. AI results are for reference only, not medical advice.",
      "end.t": "Leaner, stronger, better\nstarts here", "end.d": "Lean Ritual is in invite-only beta. Have a code? Sign up. No code yet? Send us an email.",
      "foot.aria": "Footer", "foot.privacy": "Privacy", "foot.terms": "Terms", "foot.guide": "Training guide", "foot.contact": "Contact", "foot.op": "© 2026 Jierui Intelligent Technology Service Department",
      mailSubject: "Lean Ritual invite request", mailBody: "Hi, I'd like an invite to the Lean Ritual beta.\n\nName:\nMy goal:\n",
      "alt.workout": "Workout screen suggesting today's weight from the last session"
    }
  };
  const root = document.documentElement;
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: the choice lasts this visit only */ } };
  let lang = root.getAttribute("data-lang") === "en" ? "en" : "zh";

  const film = document.getElementById("film");
  const play = document.getElementById("play");
  const note = document.getElementById("film-note");
  const wide = matchMedia("(min-width: 768px)");
  const filmBase = () => MEDIA + lang + (wide.matches ? "-16x9" : "-9x16");
  // Only the poster loads up front; the MP4 is attached when someone presses play.
  function setPoster() {
    if (!film || film.getAttribute("src")) return;
    film.poster = filmBase() + ".jpg";
  }
  function resetFilm() {
    if (!film) return;
    film.pause();
    film.removeAttribute("src");
    film.controls = false;
    film.load();
    if (play) play.hidden = false;
    setPoster();
  }
  function startFilm() {
    if (!film || !play) return;
    note.textContent = "";
    film.src = filmBase() + ".mp4";
    film.controls = true;
    play.hidden = true;
    film.play().catch(() => { /* autoplay refusal: native controls stay visible */ });
    film.focus();
  }
  if (film && play) {
    play.addEventListener("click", startFilm);
    film.addEventListener("error", () => { if (film.getAttribute("src")) { note.textContent = I18N[lang]["video.error"]; resetFilm(); } });
    film.addEventListener("ended", () => { film.controls = false; play.hidden = false; });
    wide.addEventListener("change", () => { if (film.paused) resetFilm(); });
  }

  function apply(next) {
    lang = next;
    const d = I18N[next];
    root.lang = next === "zh" ? "zh-CN" : "en";
    root.setAttribute("data-lang", next);
    document.title = d.title;
    for (const el of document.querySelectorAll("[data-i]")) { const v = d[el.dataset.i]; if (v != null) el.textContent = v; }
    for (const el of document.querySelectorAll("[data-i-aria]")) { const v = d[el.dataset.iAria]; if (v) el.setAttribute("aria-label", v); }
    for (const img of document.querySelectorAll("img[data-shot]")) {
      img.src = "/landing/img/" + next + "-" + img.dataset.shot + ".webp";
      if (img.hasAttribute("data-alt")) img.alt = d["alt." + img.dataset.shot];
    }
    const mailto = "mailto:" + CONTACT + "?subject=" + encodeURIComponent(d.mailSubject) + "&body=" + encodeURIComponent(d.mailBody);
    for (const a of document.querySelectorAll("a[data-ask]")) a.href = mailto;
    for (const b of document.querySelectorAll("button[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === next));
    if (film && film.getAttribute("src") && !film.paused) film.pause();
    resetFilm();
    if (note) note.textContent = "";
    root.removeAttribute("data-i18n-pending");
  }
  for (const b of document.querySelectorAll("button[data-lang]")) {
    b.addEventListener("click", () => {
      const next = b.dataset.lang === "en" ? "en" : "zh";
      // Same keys login.html writes, so the choice carries into sign-in and the app.
      write("bj-lang", next); write("bj-lang-set-at", String(Date.now())); write("bj-lang-pending", next);
      if (next !== lang) apply(next);
    });
  }
  apply(lang);

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function countUp(el) {
    const end = Number(el.dataset.count);
    if (!Number.isFinite(end)) return;
    if (reduce) { el.textContent = String(end); return; }
    const start = performance.now(), duration = 1100;
    const step = now => {
      const p = Math.min(1, (now - start) / duration);
      el.textContent = String(Math.round(end * (1 - Math.pow(1 - p, 4))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const reveals = document.querySelectorAll(".reveal");
  const show = el => { el.classList.add("in"); for (const n of el.querySelectorAll("[data-count]")) countUp(n); };
  if (reduce || !("IntersectionObserver" in window)) { for (const el of reveals) el.classList.add("in"); }
  else {
    const io = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { show(e.target); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    for (const el of reveals) io.observe(el);
  }
})();
