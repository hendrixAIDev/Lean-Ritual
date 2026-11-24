'use strict';

const STORYBOARDS = {
  zh: {
    lang: 'zh',
    locale: 'zh-CN',
    userName: '小林',
    voice: {
      engine: 'kokoro',
      model: 'kokoro-multi-lang-v1_1',
      speaker: 'zf_001',
      sid: 3,
      speed: 1.08,
      elevenlabs: {
        modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_v3',
        voiceId: 'MI36FIkp9wRP7cpWKPTl',
        voiceName: 'Evan Zhao - Warm, Calm and Trustworthy',
        voiceSettings: {
          stability: 0.5
        }
      },
      sayFallback: {
        preferred: ['Tingting (Enhanced)', 'Tingting (Premium)', 'Lilian (Premium)', 'Meijia (Premium)', 'Tingting'],
        rate: 192
      }
    },
    titleCard: {
      eyebrow: 'LEAN RITUAL · 手机训练饮食本',
      title: '薄肌日课',
      tagline: '每天 5 分钟，科学练出薄肌',
      pills: ['1 分钟建档', '拍照估热量', 'AI 教练复盘'],
      duration: 4.5,
      narration: '薄肌日课，每天五分钟，训练饮食一步搞定。'
    },
    outroCard: {
      eyebrow: 'LEAN RITUAL · 薄肌日课',
      title: '把好身材，拆成每天 5 分钟',
      url: 'https://leanritual.app',
      badge: '邀请制内测',
      footnote: '浏览器打开即用 · 可添加到主屏幕',
      duration: 5.5,
      narration: '薄肌日课目前邀请制内测，欢迎访问 leanritual.app 了解详情。',
      spoken: '薄机日课，现已开启邀请制内测，欢迎访问 lean ritual dot app 了解详情。'
    },
    poster: {
      eyebrow: '薄肌日课 · LEAN RITUAL',
      headline: '每天 5 分钟，科学练出薄肌',
      subline: '定制课表 · 拍照估餐 · AI 教练 · 数据随你导出',
      badge: '邀请制内测 · leanritual.app'
    },
    scenes: [
      {
        id: 'setup',
        label: '1 分钟建档 · 定制个人计划',
        chapter: '01 · 1 分钟建档',
        transition: 'circleopen',
        minDuration: 14.5,
        beats: [
          {
            caption: '填好身体数据、目标与伤病，1 分钟建档',
            callout: '60s 建档 · 身体数据 · 伤病保护',
            narration: '先花一分钟填好身体数据、目标和伤病。'
          },
          {
            caption: '立刻生成专属课表与热量目标，自动避开伤处',
            callout: '专属课表 · 1930 kcal · 伤处自动替动作',
            narration: '提交立刻生成每日课表和热量目标，还会自动替换受伤部位的动作。'
          }
        ]
      },
      {
        id: 'checkin',
        label: '今天 · 每日打卡',
        chapter: '02 · 每日打卡',
        transition: 'perspective_swing',
        minDuration: 13.0,
        beats: [
          {
            caption: '每天 10 秒记下体重、步数与睡眠',
            narration: '每天十秒记下体重、步数和睡眠。'
          },
          {
            caption: '7 日均重自动平滑波动，看清真实趋势',
            callout: '7 日均重 72.4 kg · 看清真实减脂节奏',
            narration: '保存打卡，系统用七日均重帮你过滤波动。',
            spoken: '保存打卡，系统用七天平均体重帮你过滤波动。'
          }
        ]
      },
      {
        id: 'workout_log',
        label: '记训练与记录趋势',
        chapter: '03 · 记训练 & 记录',
        transition: 'perspective_swing',
        minDuration: 23.5,
        beats: [
          {
            caption: '根据历史自动推荐重量，填完组数一键保存',
            callout: '渐进超负荷 · 自动推荐 60 kg',
            narration: '训练时按历史自动推荐重量，填完组数一键保存。',
            spoken: '训练时按历史记录自动推荐负重，填完组数一键保存。'
          },
          {
            caption: '体重曲线、热量收支与力量进步全自动生成',
            callout: '7 天均重 · 热量收支 · 力量进步',
            narration: '切换到记录页，体重、热量和力量曲线一目了然。'
          }
        ]
      },
      {
        id: 'meals',
        label: '饮食 · 拍照 AI 估算',
        chapter: '04 · 饮食拍照估算',
        transition: 'perspective_swing',
        minDuration: 18.0,
        beats: [
          {
            caption: '拍张餐食照，AI 自动估算热量与三大营养素',
            narration: '吃饭不用称重，拍张餐食照，点击 AI 估算。'
          },
          {
            caption: '热量与蛋白质秒出结果，今日进度条实时更新',
            callout: '540 kcal · 46.5g 蛋白质 · 实时更新',
            narration: '几秒钟就能算出热量和蛋白质，上方进度条也会实时更新。'
          }
        ]
      },
      {
        id: 'coach',
        label: '反馈 · AI 教练与一键撤销',
        chapter: '05 · AI 教练反馈',
        transition: 'perspective_swing',
        minDuration: 19.0,
        beats: [
          {
            caption: 'AI 教练结合近 14 天记录，给出针对性调整建议',
            callout: '14 天数据复盘 · 针对性调整建议',
            narration: '训练有紧绷或瓶颈？写句感受，AI 教练结合近十四天数据为你复盘。'
          },
          {
            caption: '建议一键采纳，不满意随时一键撤销',
            callout: '一键采纳建议 · 随时一键撤销',
            narration: '满意就一键采纳，不合适也能随时撤销。'
          }
        ]
      },
      {
        id: 'me',
        label: '我的 · 主屏幕、双语与导出',
        chapter: '06 · 我的 & 数据主权',
        transition: 'perspective_swing',
        minDuration: 14.5,
        beats: [
          {
            caption: '支持中英双语；Safari 分享即可「添加到主屏幕」',
            callout: '中英双语 · 添加到主屏幕像 App 一样打开',
            narration: '我的页面支持中英文切换，也能添加到主屏幕像原生应用一样打开。'
          },
          {
            caption: '一键导出全部记录与照片，你的数据完全属于你',
            callout: '一键导出完整记录与餐食照片',
            narration: '所有记录和照片都能一键导出，数据完全属于你。'
          }
        ]
      }
    ],
    mocks: {
      setupInjNote: '右肩前侧卧推容易发紧',
      mealNote: '鸡胸肉糙米饭配西兰花和溏心蛋',
      mealEstimate: {
        items: [
          { name: '香煎鸡胸肉', amount: '约160g' },
          { name: '糙米饭', amount: '约180g' },
          { name: '白灼西兰花', amount: '约120g' },
          { name: '溏心蛋', amount: '1个' }
        ],
        label: false,
        calc: '按常规一人份高蛋白碗估算：鸡胸肉约260kcal、糙米饭约200kcal、鸡蛋与少量橄榄油约80kcal。',
        kcal: 540,
        protein: 46.5,
        carbs: 54.0,
        fat: 14.2,
        confidence: '高',
        tip: '这一餐蛋白质充足且优质碳水比例均衡，很适合训练日午餐。',
        cmp: false
      },
      coachNote: '最近平板卧推最后一组右肩前侧有点紧，想稍微调整一下。',
      coachReview: {
        summary: '近两周减脂节奏很稳，7 日均重下降控制在理想区间，训练出勤与蛋白质达标率都很高。针对平板杠铃卧推时右肩前侧发紧，建议先换成肩关节更友好的哑铃卧推并略微提高次数区间。',
        good: [
          '7 日均重稳步下降（约 -0.7%/周），既保肌肉又不激进',
          '每周 3 次推拉腿全部完成，上斜卧推与深蹲稳步加重',
          '日均蛋白质超过 150g，睡眠稳定在 7.5 小时左右'
        ],
        issues: [
          '平板杠铃卧推末端右肩前侧发紧，若继续硬顶容易诱发肩峰撞击'
        ],
        adjustments: [
          {
            kind: 'swap',
            from: '平板杠铃卧推',
            to: '平板哑铃卧推',
            sets: 3,
            lo: 8,
            hi: 10,
            text: '把平板杠铃卧推换成平板哑铃卧推（3 组 × 8–10 次），允许手腕和肩部自然内收，明显减轻肩前侧压力。'
          },
          {
            kind: 'note',
            text: '推日热身前加做 2 组弹力带肩外旋，若仍出现刺痛请及时停练并就医评估。'
          }
        ]
      }
    }
  },

  en: {
    lang: 'en',
    locale: 'en-US',
    userName: 'Alex',
    voice: {
      engine: 'kokoro',
      model: 'kokoro-multi-lang-v1_0',
      speaker: 'af_heart',
      sid: 3,
      speed: 1.0,
      elevenlabs: {
        modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_v3',
        voiceId: 'hpp4J3VqNfWAUOO0d1Us',
        voiceName: 'Bella - Professional, Bright, Warm',
        voiceSettings: {
          stability: 0.5
        }
      },
      sayFallback: {
        preferred: ['Ava (Premium)', 'Zoe (Premium)', 'Samantha (Enhanced)', 'Samantha'],
        rate: 178
      }
    },
    titleCard: {
      eyebrow: 'LEAN RITUAL · MOBILE TRAINING LOG',
      title: 'Lean Ritual',
      tagline: '5 minutes a day to a lean, strong physique',
      pills: ['1-Min Setup', 'Photo Macro AI', 'AI Coach'],
      duration: 4.8,
      narration: 'Lean Ritual. Five minutes a day to keep your workouts, meals, and progress on track.'
    },
    outroCard: {
      eyebrow: 'LEAN RITUAL · 薄肌日课',
      title: 'Train smarter, stay lean — in 5 minutes a day',
      url: 'https://leanritual.app',
      badge: 'Invitation-only beta',
      footnote: 'Works right in your browser · Add to Home Screen',
      duration: 6.0,
      narration: 'Lean Ritual is currently in invitation-only beta. Visit leanritual.app to learn more.',
      spoken: 'Lean Ritual is currently in invitation-only beta. Visit lean ritual dot app to learn more.'
    },
    poster: {
      eyebrow: 'LEAN RITUAL',
      headline: '5 minutes a day to a lean, strong physique',
      subline: 'Tailored workouts · Photo macro AI · Reversible AI coaching',
      badge: 'Invitation-only · leanritual.app'
    },
    scenes: [
      {
        id: 'setup',
        label: '1-Minute Profile Setup',
        chapter: '01 · 1-Minute Setup',
        transition: 'circleopen',
        minDuration: 15.0,
        beats: [
          {
            caption: 'Enter your stats, goal, schedule, and injuries in 1 minute',
            callout: '60s setup · Body metrics · Injury swaps',
            narration: 'Start with a one-minute setup — enter your stats, goal, schedule, and any joint injuries.'
          },
          {
            caption: 'Get a tailored workout plan, daily macros, and joint-safe swaps',
            callout: 'Tailored plan · 1930 kcal · Joint-safe swaps',
            narration: 'Lean Ritual immediately builds your daily workout plan, macro targets, and joint-friendly swaps.'
          }
        ]
      },
      {
        id: 'checkin',
        label: 'Today · Daily Check-in',
        chapter: '02 · Daily Check-in',
        transition: 'perspective_swing',
        minDuration: 13.5,
        beats: [
          {
            caption: 'Log morning weight, steps, and sleep in 10 seconds',
            narration: 'Log your morning weight, steps, and sleep in ten seconds.'
          },
          {
            caption: '7-day rolling averages smooth out daily fluctuations',
            callout: '7-day avg 72.4 kg · Noise-free trend',
            narration: 'Tap save, and seven-day rolling averages filter out daily noise so you see real progress.'
          }
        ]
      },
      {
        id: 'workout_log',
        label: 'Log Workout & Progress Charts',
        chapter: '03 · Workouts & Log',
        transition: 'perspective_swing',
        minDuration: 24.0,
        beats: [
          {
            caption: 'Progressive load suggestions — log sets and reps in seconds',
            callout: 'Progressive overload · Auto 60 kg target',
            narration: 'During your workout, every lift suggests your next weight. Log your sets and tap finish and save.'
          },
          {
            caption: 'Weight trend, calorie balance, and strength charts update automatically',
            callout: '7-day trend · Calorie balance · Strength gains',
            narration: 'Switch to the Log tab to see your weight trend, calorie balance, and strength progress update automatically.'
          }
        ]
      },
      {
        id: 'meals',
        label: 'Meals · Photo AI Estimate',
        chapter: '04 · Photo Macro AI',
        transition: 'perspective_swing',
        minDuration: 18.5,
        beats: [
          {
            caption: 'Snap a meal photo — AI estimates calories and protein for you',
            narration: 'No tedious food weighing. Attach a meal photo with a short note and tap save and estimate with AI.'
          },
          {
            caption: 'Instant macro breakdown keeps your daily targets on track',
            callout: '540 kcal · 46.5g protein · Live daily bars',
            narration: 'Calories, protein, carbs, and fat fill in within seconds, updating your daily bars right away.'
          }
        ]
      },
      {
        id: 'coach',
        label: 'Feedback · AI Coach & One-Tap Undo',
        chapter: '05 · AI Coach Review',
        transition: 'perspective_swing',
        minDuration: 19.0,
        beats: [
          {
            caption: 'AI coach reviews your last 14 days and proposes concrete tweaks',
            callout: '14-day review · Actionable tweaks',
            narration: 'Feel tightness or hit a plateau? Leave a quick note and let the AI coach review your last two weeks.'
          },
          {
            caption: 'Apply any suggestion in one tap — undo anytime',
            callout: '1-tap apply · Undo anytime',
            narration: 'Apply any suggestion in one tap — and undo it anytime if you change your mind.'
          }
        ]
      },
      {
        id: 'me',
        label: 'Me · Home Screen, Language & Export',
        chapter: '06 · Me & Your Data',
        transition: 'perspective_swing',
        minDuration: 15.0,
        beats: [
          {
            caption: 'Switch languages anytime · Add to Home Screen for app-like access',
            callout: 'EN / 中文 · Add to Home Screen like a native app',
            narration: 'In the Me tab, switch between English and Chinese anytime, or add Lean Ritual to your home screen like a native app.'
          },
          {
            caption: 'Export all your logs and photos in one tap — your data stays yours',
            callout: 'One-tap full data & photo export',
            narration: 'Export all your logs and meal photos whenever you like — your data always belongs to you.'
          }
        ]
      }
    ],
    mocks: {
      setupInjNote: 'Front right shoulder gets tight on flat bench',
      mealNote: 'Grilled chicken breast bowl with brown rice, broccoli, and soft-boiled egg',
      mealEstimate: {
        items: [
          { name: 'Grilled chicken breast', amount: '~160g' },
          { name: 'Brown rice', amount: '~180g' },
          { name: 'Steamed broccoli', amount: '~120g' },
          { name: 'Soft-boiled egg', amount: '1 large' }
        ],
        label: false,
        calc: 'Standard single-serving high-protein bowl: chicken ~260 kcal, brown rice ~200 kcal, egg & light oil ~80 kcal.',
        kcal: 540,
        protein: 46.5,
        carbs: 54.0,
        fat: 14.2,
        confidence: 'High',
        tip: 'Strong protein hit with clean carbs — ideal fuel for a training-day lunch.',
        cmp: false
      },
      coachNote: 'Right front shoulder felt a bit tight on the last set of flat bench press.',
      coachReview: {
        summary: 'Your cut is pacing right on target with steady 7-day weight loss, 100% workout adherence, and solid protein intake. To ease front-shoulder tightness on barbell bench, swap to neutral-path dumbbell bench for moderate reps.',
        good: [
          '7-day average weight trending steadily down (~ -0.7%/week)',
          'Completed all 3 weekly Push/Pull/Legs sessions with steady load progression',
          'Averaging over 150g protein/day and ~7.5h sleep'
        ],
        issues: [
          'Front-shoulder tightness on flat barbell bench press — pushing through risks irritation'
        ],
        adjustments: [
          {
            kind: 'swap',
            from: '平板杠铃卧推',
            to: '平板哑铃卧推',
            sets: 3,
            lo: 8,
            hi: 10,
            text: 'Swap Barbell Bench Press to Dumbbell Bench Press (3 sets × 8–10 reps) for a freer shoulder path and less anterior load.'
          },
          {
            kind: 'note',
            text: 'Add 2 light sets of band external rotations before Push warm-ups; stop and consult a clinician if sharp pain develops.'
          }
        ]
      }
    }
  }
};

function formatScriptMarkdown(sb, timeline = [], meta = {}) {
  const isZh = sb.lang === 'zh';
  const voiceDesc =
    meta.voiceLabel ||
    `Kokoro-82M (${sb.voice.model} · ${sb.voice.speaker}, speed ${sb.voice.speed}, Apache-2.0)`;
  const lines = [];
  lines.push(
    isZh
      ? `# 薄肌日课（Lean Ritual）产品介绍视频脚本 v5（中文版）`
      : `# Lean Ritual Product Walkthrough Script v5 (English)`
  );
  lines.push('');
  lines.push(
    isZh
      ? `- 目标受众：真实健身用户（非测试说明）\n- 规格：1080×1920 竖屏 & 1920×1080 横屏 · 30fps · H.264 + AAC · 约 2 分钟\n- 配音引擎：${voiceDesc}\n- 音频设计：原创 116 BPM 活力电子电钢背景乐（人声自动闪避）+ 节拍转场冲击、交互点击与提示音效`
      : `- Audience: Everyday lifters & beta invitees\n- Formats: 1080×1920 vertical & 1920×1080 widescreen · 30fps · H.264 + AAC · ~2 minutes\n- Voiceover: ${voiceDesc}\n- Sound design: Original upbeat 116 BPM synth-Rhodes BGM (sidechain-ducked under voice) + beat-synced transition impact, UI tap & chime SFX`
  );
  lines.push('');
  lines.push(isZh ? `## 分镜与文案` : `## Storyboard & Script`);
  lines.push('');

  const byId = new Map(timeline.map(item => [item.id, item]));
  const fmtRange = id => {
    const t = byId.get(id);
    if (!t) return '';
    const mmss = s => {
      const whole = Math.max(0, Math.round(s));
      const m = Math.floor(whole / 60);
      const sec = whole % 60;
      return `${m}:${String(sec).padStart(2, '0')}`;
    };
    return ` (${mmss(t.start)}–${mmss(t.end)}, ${t.duration.toFixed(1)}s)`;
  };

  lines.push(`### 0. ${isZh ? '片头动画标题卡' : 'Animated Title Card'}${fmtRange('title')}`);
  lines.push(`- ${isZh ? '画面文案' : 'On-screen'}: **${sb.titleCard.title}** — ${sb.titleCard.tagline}`);
  lines.push(`- ${isZh ? '旁白' : 'Voiceover'}: ${sb.titleCard.narration}`);
  lines.push('');

  sb.scenes.forEach((sc, idx) => {
    lines.push(`### ${idx + 1}. ${sc.label}${fmtRange(sc.id)}`);
    sc.beats.forEach((b, bi) => {
      const prefix = sc.beats.length > 1 ? ` [${bi + 1}/${sc.beats.length}]` : '';
      lines.push(`- ${isZh ? '字幕' : 'Caption'}${prefix}: ${b.caption}`);
      if (b.callout) lines.push(`- ${isZh ? '动态提示条' : 'Callout'}${prefix}: ${b.callout}`);
      lines.push(`- ${isZh ? '旁白' : 'Voiceover'}${prefix}: ${b.narration}`);
    });
    lines.push('');
  });

  lines.push(`### ${sb.scenes.length + 1}. ${isZh ? '片尾动画品牌卡' : 'Animated Outro Card'}${fmtRange('outro')}`);
  lines.push(`- ${isZh ? '画面文案' : 'On-screen'}: ${sb.outroCard.title} · \`${sb.outroCard.url}\` · ${sb.outroCard.badge}`);
  lines.push(`- ${isZh ? '旁白' : 'Voiceover'}: ${sb.outroCard.narration}`);
  lines.push('');

  return lines.join('\n');
}

module.exports = { STORYBOARDS, formatScriptMarkdown };
