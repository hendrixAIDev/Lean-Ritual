// Landing page behaviour: zh/en copy swap without reload, the intro video
// (fetched only when someone presses play), scroll reveals and count-ups.
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
      lede: "训练、饮食、体重，需要的都在这里。为你定制，AI 持续调整。",
      "cta.invite": "用邀请码注册", "cta.signin": "登录", "cta.ask": "还没有邀请码？发邮件申请",
      "st1.k": "今天建议", "st2.k": "7 天平均",
      t1: "10 秒打卡", t2: "7 天平均", t3: "今天建议 60 kg", t4: "拍照算热量", t5: "AI 教练复盘", t6: "一键撤销", t7: "一键导出",
      "video.t": "70 秒看懂薄肌日课", "video.d": "从建档到复盘，一次看完一天怎么用。", "video.play": "播放介绍视频", "video.meta": "中文配音 · 1:11",
      "video.error": "视频暂时无法播放，请稍后再试。",
      "setup.unit": "分钟", "setup.t1": "1 分钟，填好目标和身体状况", "setup.t2": "为你定制，AI 持续调整",
      "setup.d": "计划按你的目标和身体定制，伤病也会考虑。之后 AI 教练随你进步不断调整。",
      "board.t": "每天的数字，替你说话",
      "f1.unit": "秒", "f1.t": "每天 10 秒打卡", "f1.d": "记下体重、步数和睡眠。看 7 天平均，不被每天的起伏干扰。", "f1.chip": "7 天平均 72.4 kg",
      "f2.t": "每次训练，告诉你练多重", "f2.d": "每个动作都会建议今天的重量，练完一键保存。", "f2.chip": "今天建议 60 kg",
      "f3.t": "拍张照，AI 帮你算热量", "f3.d": "吃饭不用称重。几秒算出热量和蛋白质，今天还差多少一看就知道。", "f3.chip": "540 kcal · 蛋白质 46.5 g",
      "f4.unit": "周", "f4.t": "AI 教练帮你复盘", "f4.d": "卡住了？写一句感受，AI 教练看完两周数据给你建议。", "f4.chip": "一键采纳，随时撤销",
      "f5.unit": "条曲线", "f5.t": "进步一目了然", "f5.d": "体重、热量和力量的变化，都画成曲线。", "f5.chip": "体重 · 热量 · 力量",
      "x1.t": "你的数据，随时带走", "x1.d": "记录和照片，一键导出。", "x2.t": "像 App 一样放在主屏幕", "x2.d": "不用下载安装，浏览器打开就能用。", "x3.d": "中英文随时切换。",
      "ai.t": "AI 只用在两个地方", "ai.1t": "看餐食照片", "ai.1d": "估算热量和蛋白质，结果你可以随时改。", "ai.2t": "帮你复盘", "ai.2d": "给出调整建议，采纳还是撤销，你说了算。",
      "ai.note": "其余部分按你的目标和记录计算。AI 建议仅供参考，不构成医疗建议。",
      "end.t": "更瘦、更强、更好，\n从这里开始", "end.d": "薄肌日课正在邀请制内测。有邀请码就能注册；还没有的话，给我们发封邮件。",
      "foot.aria": "页脚", "foot.privacy": "隐私说明", "foot.terms": "使用条款", "foot.guide": "训练与饮食纲领", "foot.contact": "联系我们", "foot.op": "© 2026 杰瑞智能技术服务部",
      mailSubject: "申请薄肌日课内测邀请", mailBody: "你好，我想申请薄肌日课的内测邀请。\n\n我的称呼：\n想达成的目标：\n",
      "alt.workout": "训练页：每个动作建议今天的重量"
    },
    en: {
      title: "Lean Ritual · One app to get leaner, stronger, better", brand: "Lean Ritual", brand2: "薄肌日课", "lang.aria": "Language",
      "nav.signin": "Sign in", beta: "Invite-only beta", "h.full": "One app to get leaner, stronger, better", "h.pre": "One app to get",
      "h.w1": "Leaner", "h.w2": "Stronger", "h.w3": "Better",
      lede: "Workouts, meals and weight, all in one place. Made for you, tuned by AI.",
      "cta.invite": "Use your invite", "cta.signin": "Sign in", "cta.ask": "No invite yet? Ask for one",
      "st1.k": "Today", "st2.k": "7-day avg",
      t1: "10-second check-in", t2: "7-day average", t3: "Today: 60 kg", t4: "Snap a meal", t5: "AI coach review", t6: "Undo anytime", t7: "One-tap export",
      "video.t": "Lean Ritual in 90 seconds", "video.d": "From setup to coach review: one day with the app.", "video.play": "Play the intro video", "video.meta": "English voiceover · 1:24",
      "video.error": "The video can't play right now. Please try again later.",
      "setup.unit": "min", "setup.t1": "1 minute: your goal and body", "setup.t2": "Made for you, tuned by AI",
      "setup.d": "Your plan fits your goal and body, injuries included. Then your AI coach keeps adjusting it as you progress.",
      "board.t": "Your day, by the numbers",
      "f1.unit": "sec", "f1.t": "10-second daily check-in", "f1.d": "Log weight, steps and sleep. Watch the 7-day average, not the daily ups and downs.", "f1.chip": "7-day avg 72.4 kg",
      "f2.t": "Know what weight to lift", "f2.d": "Each lift suggests today's weight. Log it in one tap.", "f2.chip": "Today: 60 kg",
      "f3.t": "Snap a photo, AI counts it", "f3.d": "No scales. Calories and protein in seconds, so you know what's left today.", "f3.chip": "540 kcal · 46.5 g protein",
      "f4.unit": "wks", "f4.t": "Your AI coach checks in", "f4.d": "Stuck? Write one line, and your AI coach reviews two weeks and suggests fixes.", "f4.chip": "Apply in a tap. Undo anytime.",
      "f5.unit": "charts", "f5.t": "See your progress", "f5.d": "Weight, calories and strength, all in clear charts.", "f5.chip": "Weight · Calories · Strength",
      "x1.t": "Your data, yours to keep", "x1.d": "Export your records and photos in one tap.", "x2.t": "On your home screen", "x2.d": "Nothing to install. It opens right in your browser.", "x3.d": "Switch languages anytime.",
      "ai.t": "AI does exactly two jobs", "ai.1t": "Reads your meal photos", "ai.1d": "Estimates calories and protein. You can edit the result.", "ai.2t": "Reviews your progress", "ai.2d": "Suggests tweaks. Apply or undo, your call.",
      "ai.note": "Everything else is calculated from your goal and your logs. AI suggestions are for reference only, not medical advice.",
      "end.t": "Leaner, stronger, better\nstarts here", "end.d": "Lean Ritual is in invite-only beta. Have a code? Sign up. No code yet? Send us an email.",
      "foot.aria": "Footer", "foot.privacy": "Privacy", "foot.terms": "Terms", "foot.guide": "Training guide", "foot.contact": "Contact", "foot.op": "© 2026 Jierui Intelligent Technology Service Department",
      mailSubject: "Lean Ritual invite request", mailBody: "Hi, I'd like an invite to the Lean Ritual beta.\n\nName:\nMy goal:\n",
      "alt.workout": "Workout screen suggesting today's weight for each lift"
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
