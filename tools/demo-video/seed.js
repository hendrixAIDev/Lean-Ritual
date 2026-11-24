'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'demo-ritual-pass-2026';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function localDateStr(offsetDays = 0) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function readMails(dir) {
  const mailDir = path.join(dir, 'mail');
  if (!fs.existsSync(mailDir)) return [];
  return fs
    .readdirSync(mailDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(mailDir, f), 'utf8')));
}

async function startLocalServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-demo-video-'));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir,
    PORT: String(port),
    HOST: '127.0.0.1',
    AUTH_BASE_URL: base,
    AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
    COOKIE_SECURE: '0',
    TRUST_PROXY: '0',
    MAIL_MODE: 'file',
    // Enable AI UI controls with a non-functional mock key (Playwright intercepts all /api/ai calls).
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'demo-mock-key',
    OPENROUTER_BASE: 'https://openrouter.ai/api/v1',
    GEMINI_API_KEY: '',
    ...extraEnv
  };

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  server.stderr.on('data', d => { stderr += d.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout: ' + stderr)), 10000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', reject);
    server.once('exit', () => { clearTimeout(timer); reject(new Error('server exited early: ' + stderr)); });
  });

  const invite = email => {
    const issued = spawnSync(process.execPath, ['scripts/auth-admin.js', 'invite', email], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 8000
    });
    if (issued.error) throw issued.error;
    assert.equal(issued.status, 0, issued.stderr);
    return JSON.parse(issued.stdout);
  };

  const stop = async () => {
    if (server.exitCode === null) {
      const stopped = new Promise(r => server.once('exit', r));
      server.kill();
      await stopped;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { dir, base, env, invite, stop };
}

function buildSyntheticData(lang, breakfastBlobId) {
  const isZh = lang === 'zh';
  const today = localDateStr(0);
  const startDate = localDateStr(-21);
  const dow = new Date().getDay();
  const trainDays = [...new Set([dow, (dow + 2) % 7, (dow + 5) % 7])].sort((a, b) => a - b);

  const profile = {
    sex: 'm',
    age: 28,
    height: 176,
    weight: 74.4,
    bf: 16.5,
    steps: 9500,
    exp: 'mid',
    stage: 'auto',
    trainDays,
    slot: 'eve',
    equipment: 'gym',
    injuries: [],
    injNote: '',
    supps: ['protein', 'creatine'],
    startDate,
    kcalAdjust: 0,
    deloadEvery: 9,
    lang,
    schema: 2,
    updatedAt: new Date().toISOString()
  };

  const dailyTargets = { kcal: 1940, protein: 160, carbs: 210, fat: 51, tdee: 2500, st: 'cut' };

  const mealPools = isZh
    ? {
        breakfast: [
          { text: '希腊酸奶燕麦杯配蓝莓、水煮蛋 2 个', kcal: 460, protein: 34, carbs: 52, fat: 12 },
          { text: '全麦吐司配煎蛋、无糖豆浆', kcal: 450, protein: 31, carbs: 50, fat: 13 },
          { text: '鸡蛋白煎饼配牛奶和半根香蕉', kcal: 470, protein: 35, carbs: 54, fat: 11 }
        ],
        lunch: [
          { text: '香煎鸡胸肉糙米饭配西兰花', kcal: 690, protein: 58, carbs: 74, fat: 16 },
          { text: '黑椒牛柳藜麦饭配时蔬', kcal: 710, protein: 54, carbs: 72, fat: 20 },
          { text: '照烧三文鱼杂粮饭配毛豆', kcal: 730, protein: 52, carbs: 70, fat: 22 }
        ],
        dinner: [
          { text: '清蒸鳕鱼配红薯、炒青菜、一勺蛋白粉', kcal: 770, protein: 66, carbs: 78, fat: 18 },
          { text: '嫩煎牛排配土豆泥和沙拉、乳清蛋白', kcal: 790, protein: 68, carbs: 74, fat: 21 },
          { text: '虾仁豆腐蔬菜汤配杂粮饭', kcal: 740, protein: 62, carbs: 76, fat: 17 }
        ]
      }
    : {
        breakfast: [
          { text: 'Greek yogurt oat bowl with blueberries & 2 boiled eggs', kcal: 460, protein: 34, carbs: 52, fat: 12 },
          { text: 'Whole-grain toast, scrambled eggs & skim milk', kcal: 450, protein: 31, carbs: 50, fat: 13 },
          { text: 'Egg-white wrap with oatmeal & half banana', kcal: 470, protein: 35, carbs: 54, fat: 11 }
        ],
        lunch: [
          { text: 'Seared chicken breast with brown rice & broccoli', kcal: 690, protein: 58, carbs: 74, fat: 16 },
          { text: 'Lean beef quinoa bowl with roasted veggies', kcal: 710, protein: 54, carbs: 72, fat: 20 },
          { text: 'Teriyaki salmon grain bowl with edamame', kcal: 730, protein: 52, carbs: 70, fat: 22 }
        ],
        dinner: [
          { text: 'Baked cod, sweet potato, greens & whey shake', kcal: 770, protein: 66, carbs: 78, fat: 18 },
          { text: 'Lean sirloin, mashed potatoes, salad & whey', kcal: 790, protein: 68, carbs: 74, fat: 21 },
          { text: 'Garlic shrimp tofu bowl with steamed rice', kcal: 740, protein: 62, carbs: 76, fat: 17 }
        ]
      };

  const makeSets = (w, reps) => reps.map(r => ({ w: String(w), r: String(r) }));

  const workoutTemplates = {
    push: idx => ({
      key: 'push',
      done: true,
      slot: 'eve',
      feel: idx === 2 ? '2' : '3',
      pain: 'none',
      painArea: '',
      note: '',
      exercises: [
        { name: '上斜杠铃卧推', sets: makeSets([55, 57.5, 57.5][idx], [[5, 5, 5], [5, 5, 6], [6, 6, 6]][idx]) },
        { name: '平板杠铃卧推', sets: makeSets([62.5, 65, 65][idx], [[5, 5, 5], [5, 5, 5], [6, 6, 6]][idx]) },
        { name: '站姿杠铃推举', sets: makeSets([37.5, 40, 40][idx], [[5, 5, 5], [5, 5, 5], [6, 6, 5]][idx]) },
        { name: '侧平举', sets: makeSets([8, 8, 9][idx], [[12, 12, 12], [14, 14, 13], [12, 12, 12]][idx]) },
        { name: '三头伸展（绳索/哑铃）', sets: makeSets([18, 19, 20][idx], [[10, 10, 10], [10, 10, 11], [10, 10, 10]][idx]) }
      ]
    }),
    pull: idx => ({
      key: 'pull',
      done: true,
      slot: 'eve',
      feel: '2',
      pain: 'none',
      painArea: '',
      note: '',
      exercises: [
        { name: '硬拉', sets: makeSets([95, 100, 102.5][idx], [[5, 5, 5], [5, 5, 5], [6, 5, 5]][idx]) },
        { name: '引体向上（能做 6 个后负重）', sets: makeSets([2.5, 5, 5][idx], [[5, 5, 5], [5, 5, 5], [6, 6, 5]][idx]) },
        { name: '杠铃划船', sets: makeSets([55, 57.5, 60][idx], [[6, 5, 5], [6, 6, 5], [5, 5, 5]][idx]) },
        { name: '面拉', sets: makeSets([15, 16, 17][idx], [[13, 13, 13], [14, 14, 13], [14, 14, 14]][idx]) },
        { name: '二头弯举', sets: makeSets([12, 12, 13][idx], [[10, 10, 10], [11, 11, 10], [10, 10, 10]][idx]) }
      ]
    }),
    legs: idx => ({
      key: 'legs',
      done: true,
      slot: 'eve',
      feel: '3',
      pain: 'none',
      painArea: '',
      note: '',
      exercises: [
        { name: '深蹲', sets: makeSets([80, 82.5, 85][idx], [[5, 5, 5], [5, 5, 6], [5, 5, 5]][idx]) },
        { name: '罗马尼亚硬拉', sets: makeSets([70, 72.5, 75][idx], [[7, 7, 7], [8, 7, 7], [7, 7, 7]][idx]) },
        { name: '哑铃推举', sets: makeSets([18, 19, 20][idx], [[6, 6, 5], [6, 6, 6], [5, 5, 5]][idx]) },
        { name: '侧平举', sets: makeSets([8, 9, 9][idx], [[12, 12, 12], [12, 12, 12], [13, 13, 12]][idx]) },
        { name: '面拉或后飞鸟', sets: makeSets([15, 16, 16][idx], [[14, 14, 13], [14, 14, 14], [15, 14, 14]][idx]) },
        { name: '腹肌（悬垂举腿/器械卷腹）', sets: makeSets([0, 0, 0][idx], [[12, 12, 12], [13, 13, 12], [14, 14, 13]][idx]) }
      ]
    })
  };

  // 9 completed workouts over the last 3 weeks, ending with 'legs' 2 days ago
  // so today is guaranteed to be Day 1 · Push (推), and saving today's workout brings last-7d to 3/3!
  const workoutSchedule = new Map([
    [-21, ['push', 0]],
    [-19, ['pull', 0]],
    [-16, ['legs', 0]],
    [-14, ['push', 1]],
    [-12, ['pull', 1]],
    [-9, ['legs', 1]],
    [-7, ['push', 2]],
    [-5, ['pull', 2]],
    [-2, ['legs', 2]]
  ]);

  const weightNoise = [0.0, 0.1, -0.1, 0.15, -0.05, 0.05, -0.1, 0.1, 0.0, -0.15, 0.05, 0.1, -0.1, 0.0, 0.1, -0.05, 0.05, -0.1, 0.05, -0.05, 0.0];
  const stepSeries = [9200, 10100, 8800, 9600, 10400, 9100, 8900, 9800, 10200, 9400, 8700, 9900, 10500, 9300, 9700, 9100, 10300, 9500, 8900, 9800, 9600];
  const sleepSeries = [7.5, 7.2, 7.8, 7.4, 7.6, 8.0, 7.5, 7.3, 7.7, 7.5, 7.4, 7.8, 7.6, 7.5, 7.4, 7.9, 7.6, 7.5, 7.3, 7.8, 7.6];

  const days = [];
  for (let offset = -21; offset <= -1; offset++) {
    const i = offset + 21;
    const date = localDateStr(offset);
    // Gentle linear cut from 74.4 kg -> 72.5 kg (~ -0.63 kg/week, ~ -0.85%/wk)
    const baseWeight = 74.4 - (i / 20) * 1.9;
    const weight = Math.round((baseWeight + weightNoise[i]) * 10) / 10;
    const bf = Math.round((16.7 - (i / 20) * 0.9) * 10) / 10;

    const bfMeal = mealPools.breakfast[i % 3];
    const lnMeal = mealPools.lunch[i % 3];
    const dnMeal = mealPools.dinner[i % 3];

    const meals = [
      {
        id: `m_${date}_b`,
        type: '早餐',
        time: '08:15',
        text: bfMeal.text,
        est: { kcal: bfMeal.kcal, protein: bfMeal.protein, carbs: bfMeal.carbs, fat: bfMeal.fat, confidence: isZh ? '高' : 'High', by: 'server' }
      },
      {
        id: `m_${date}_l`,
        type: '午餐',
        time: '12:30',
        text: lnMeal.text,
        est: { kcal: lnMeal.kcal, protein: lnMeal.protein, carbs: lnMeal.carbs, fat: lnMeal.fat, confidence: isZh ? '高' : 'High', by: 'server' }
      },
      {
        id: `m_${date}_d`,
        type: '晚餐',
        time: '19:10',
        text: dnMeal.text,
        est: { kcal: dnMeal.kcal, protein: dnMeal.protein, carbs: dnMeal.carbs, fat: dnMeal.fat, confidence: isZh ? '中' : 'Medium', by: 'server' }
      }
    ];

    const doc = {
      date,
      targets: dailyTargets,
      checkin: { weight, steps: stepSeries[i], sleep: sleepSeries[i], bf },
      meals
    };

    if (workoutSchedule.has(offset)) {
      const [key, idx] = workoutSchedule.get(offset);
      doc.workout = {
        ...workoutTemplates[key](idx),
        savedAt: new Date(Date.now() + offset * 86400e3).toISOString()
      };
    }

    days.push(doc);
  }

  // Today: breakfast already logged (with photo) so macro bars look lived-in before Scene 3 logs lunch.
  const todayBf = mealPools.breakfast[0];
  days.push({
    date: today,
    targets: dailyTargets,
    meals: [
      {
        id: `m_${today}_b`,
        type: '早餐',
        time: '08:10',
        text: todayBf.text,
        ...(breakfastBlobId ? { photo: breakfastBlobId } : {}),
        est: {
          kcal: todayBf.kcal,
          protein: todayBf.protein,
          carbs: todayBf.carbs,
          fat: todayBf.fat,
          confidence: isZh ? '高' : 'High',
          by: 'server',
          photoUsed: !!breakfastBlobId
        }
      }
    ]
  });

  return { profile, days, today };
}

async function registerAndLogin(browser, srv, sb, email) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: sb.locale,
    colorScheme: 'light'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  const inv = srv.invite(email);
  const invUrl = `${inv.url}&lang=${sb.lang}`;
  await page.goto(invUrl);
  await page.locator('#n').fill(sb.userName);
  await page.locator('#p').fill(DEMO_PASSWORD);
  await page.locator('#c-terms').check();
  await page.locator('#c-sensitive').check();
  await page.locator('#go').click();
  const expectedVerifyMsg =
    sb.lang === 'zh'
      ? '请查收验证邮件，验证后再登录。'
      : 'Check your email and verify your address before signing in.';
  await page.getByText(expectedVerifyMsg, { exact: true }).waitFor();

  const verifyMail = readMails(srv.dir).find(m => m.kind === 'verify' && m.to === email);
  assert.ok(verifyMail, `Expected verification email for ${email} in local file mail dir`);
  await page.goto(verifyMail.url);
  await page.waitForURL(u => u.pathname === '/login.html');

  await page.locator('#e').fill(email);
  await page.locator('#p').fill(DEMO_PASSWORD);
  await page.locator('#go').click();
  await page.locator('#setup').waitFor({ state: 'visible' });

  const me = await page.evaluate(async () => {
    const r = await fetch('/api/me', { credentials: 'same-origin', headers: { 'X-Bojin': '1' } });
    if (!r.ok) throw new Error('/api/me failed: ' + r.status);
    return r.json();
  });
  await page.evaluate(lang => {
    localStorage.setItem('bj-lang', lang);
  }, sb.lang);

  return { context, page, uid: me.id };
}

async function seedDemoAccount(browser, sb, breakfastPhotoPath) {
  const srv = await startLocalServer();
  let mainCtx = null;
  let setupCtx = null;

  try {
    // 1. Fresh un-profiled synthetic account for the real 1-Minute Setup onboarding scene
    const setupAcc = await registerAndLogin(browser, srv, sb, 'setup-demo@example.com');
    setupCtx = setupAcc.context;
    const setupStorageState = await setupCtx.storageState();
    const setupUid = setupAcc.uid;
    await setupCtx.close();
    setupCtx = null;

    // 2. Main synthetic account seeded with 3 weeks of realistic logs for walkthrough scenes
    const mainAcc = await registerAndLogin(browser, srv, sb, DEMO_EMAIL);
    mainCtx = mainAcc.context;
    const page = mainAcc.page;
    const uid = mainAcc.uid;

    const breakfastB64 = breakfastPhotoPath ? fs.readFileSync(breakfastPhotoPath).toString('base64') : null;
    let breakfastBlobId = null;
    if (breakfastB64) {
      breakfastBlobId = await page.evaluate(async b64 => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const res = await fetch('/api/assets', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-Bojin': '1', 'Content-Type': 'image/jpeg' },
          body: bytes
        });
        if (!res.ok) throw new Error('upload breakfast failed: ' + res.status);
        const j = await res.json();
        return j.id;
      }, breakfastB64);
    }

    const { profile, days, today } = buildSyntheticData(sb.lang, breakfastBlobId);

    await page.evaluate(async ({ uid: userId, profileDoc, dayDocs }) => {
      const put = async (relPath, data) => {
        const p = `data/users/${userId}/app/${relPath}`;
        const res = await fetch('/api/doc?path=' + encodeURIComponent(p), {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'X-Bojin': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ data })
        });
        if (!res.ok) throw new Error(`PUT ${relPath} failed: ${res.status}`);
      };
      await put('app/profile', profileDoc);
      for (const d of dayDocs) {
        await put(`days/${d.date}`, d);
      }
      localStorage.setItem('bj-lang', profileDoc.lang);
      localStorage.setItem('bj-tab', 'today');
      localStorage.setItem('bj-mmode', 'ai');
    }, { uid, profileDoc: profile, dayDocs: days });

    // Reload once to verify seeded state renders cleanly with zero setup screen
    await page.reload();
    await page.locator('#tabs').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#setup').count(), 0);

    const storageState = await mainCtx.storageState();
    return { srv, storageState, today, uid, setupStorageState, setupUid };
  } catch (err) {
    await srv.stop().catch(() => {});
    throw err;
  } finally {
    if (setupCtx) await setupCtx.close().catch(() => {});
    if (mainCtx) await mainCtx.close().catch(() => {});
  }
}

module.exports = {
  DEMO_EMAIL,
  localDateStr,
  startLocalServer,
  seedDemoAccount
};
