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
      pills: ['每日课表', '拍照估热量', 'AI 教练复盘'],
      duration: 4.8,
      narration: '薄肌日课，每天五分钟，把训练、饮食和体重装进一本随身计划。'
    },
    outroCard: {
      eyebrow: 'LEAN RITUAL · 薄肌日课',
      title: '把好身材，拆成每天 5 分钟',
      url: 'https://leanritual.app',
      badge: '邀请制内测',
      footnote: '浏览器打开即用 · 可添加到主屏幕',
      duration: 6.2,
      narration: '薄肌日课目前采用邀请制内测，欢迎访问 leanritual.app 了解详情。',
      spoken: '薄肌日课目前采用邀请制内测，欢迎访问 lean ritual dot app 了解详情。'
    },
    poster: {
      eyebrow: '薄肌日课 · LEAN RITUAL',
      headline: '每天 5 分钟，科学练出薄肌',
      subline: '训练计划 · 拍照估餐 · AI 教练 · 数据随你导出',
      badge: '邀请制内测 · leanritual.app'
    },
    scenes: [
      {
        id: 'hook',
        label: '今日概览',
        chapter: '薄肌日课 · 今天',
        transition: 'circleopen',
        minDuration: 5.2,
        beats: [
          {
            caption: '打开即看今日课表，练什么、吃多少一目了然',
            narration: '打开就是今天的训练和热量目标，不用自己算，照着练就行。'
          }
        ]
      },
      {
        id: 'checkin',
        label: '今天 · 每日打卡',
        chapter: '01 · 每日打卡',
        transition: 'smoothleft',
        minDuration: 15.0,
        beats: [
          {
            caption: '每天 10 秒记下体重、步数与睡眠',
            narration: '每天花十秒，记下晨起体重、步数和睡眠。'
          },
          {
            caption: '7 日均重自动平滑波动，看清真实趋势',
            callout: '7 日均重平滑波动 · 看清真实减脂节奏',
            narration: '点击保存打卡，系统用七日均重帮你过滤波动，看清真实变化。',
            spoken: '点击保存打卡，系统用七天平均体重帮你过滤波动，看清真实变化。'
          }
        ]
      },
      {
        id: 'workout_log',
        label: '记训练与记录趋势',
        chapter: '02 · 记训练 & 记录',
        transition: 'smoothleft',
        minDuration: 26.5,
        beats: [
          {
            caption: '根据历史自动推荐重量，填完组数一键保存',
            callout: '智能渐进超负荷 · 自动推荐今日重量',
            narration: '训练时每个动作都会按上次记录推荐重量，填好每组重量和次数，点击完成训练保存。'
          },
          {
            caption: '体重曲线、热量收支与力量进步全自动生成',
            callout: '体重曲线 · 热量收支 · 力量进步',
            narration: '切到记录页，体重趋势、热量缺口和力量进步曲线一目了然，每一点进步都看得见。'
          }
        ]
      },
      {
        id: 'meals',
        label: '饮食 · 拍照 AI 估算',
        chapter: '03 · 饮食拍照估算',
        transition: 'smoothup',
        minDuration: 19.5,
        beats: [
          {
            caption: '拍张餐食照，AI 自动估算热量与三大营养素',
            narration: '吃饭也不用挨个称重。选一张餐食照片，简单写一句备注，点保存并 AI 估算。'
          },
          {
            caption: '热量与蛋白质秒出结果，今日进度条实时更新',
            callout: '540 kcal · 46.5g 蛋白质 · 进度条实时更新',
            narration: '几秒内自动算出热量和蛋白质，上方的营养进度条也会实时更新。'
          }
        ]
      },
      {
        id: 'coach',
        label: '反馈 · AI 教练与一键撤销',
        chapter: '04 · AI 教练反馈',
        transition: 'smoothleft',
        minDuration: 22.0,
        beats: [
          {
            caption: 'AI 教练结合近 14 天记录，给出针对性调整建议',
            narration: '练完觉得有紧绷或瓶颈，在反馈页写一句感受，让 AI 教练结合近十四天数据帮你复盘。'
          },
          {
            caption: '只改今天、长期调整或不采纳 — 随时一键撤销',
            callout: '只改今天 · 长期调整 · 随时一键撤销',
            narration: '每条建议都能选只改今天、长期调整或不采纳；改完不满意，还能随时一键撤销。'
          }
        ]
      },
      {
        id: 'me',
        label: '我的 · 主屏幕、双语与导出',
        chapter: '05 · 我的 & 数据主权',
        transition: 'smoothleft',
        minDuration: 16.0,
        beats: [
          {
            caption: '支持中英双语；Safari 分享即可「添加到主屏幕」',
            callout: 'iPhone 分享 → 添加到主屏幕，像 App 一样打开',
            narration: '在我的页面可以随时切换中英文，也能通过浏览器添加到主屏幕，像原生应用一样打开。'
          },
          {
            caption: '一键导出全部记录与照片，你的数据完全属于你',
            callout: '一键导出完整记录与餐食照片',
            narration: '所有训练记录和餐食照片都能随时一键导出，你的数据永远属于你。'
          }
        ]
      }
    ],
    mocks: {
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
      pills: ['Daily Plan', 'Photo Macro AI', 'AI Coach'],
      duration: 4.8,
      narration: 'Lean Ritual. Five minutes a day to keep your workouts, meals, and progress on track.'
    },
    outroCard: {
      eyebrow: 'LEAN RITUAL · 薄肌日课',
      title: 'Train smarter, stay lean — in 5 minutes a day',
      url: 'https://leanritual.app',
      badge: 'Invitation-only beta',
      footnote: 'Works right in your browser · Add to Home Screen',
      duration: 6.2,
      narration: 'Lean Ritual is currently in invitation-only beta. Visit leanritual.app to learn more.',
      spoken: 'Lean Ritual is currently in invitation-only beta. Visit lean ritual dot app to learn more.'
    },
    poster: {
      eyebrow: 'LEAN RITUAL',
      headline: '5 minutes a day to a lean, strong physique',
      subline: 'Smart workouts · Photo macro AI · Reversible AI coaching',
      badge: 'Invitation-only · leanritual.app'
    },
    scenes: [
      {
        id: 'hook',
        label: 'Today Overview',
        chapter: 'Lean Ritual · Today',
        transition: 'circleopen',
        minDuration: 5.2,
        beats: [
          {
            caption: 'Open the app to see today’s workout and macro targets at a glance',
            narration: 'Open the app and see today’s workout and daily macro targets right away.'
          }
        ]
      },
      {
        id: 'checkin',
        label: 'Today · Daily Check-in',
        chapter: '01 · Daily Check-in',
        transition: 'smoothleft',
        minDuration: 15.0,
        beats: [
          {
            caption: 'Log morning weight, steps, and sleep in 10 seconds',
            narration: 'Log your morning weight, steps, and sleep in ten seconds.'
          },
          {
            caption: '7-day rolling averages smooth out daily fluctuations',
            callout: '7-day rolling average · Noise-free trend',
            narration: 'Tap save, and seven-day rolling averages filter out daily noise so you see real progress.'
          }
        ]
      },
      {
        id: 'workout_log',
        label: 'Log Workout & Progress Charts',
        chapter: '02 · Workouts & Log',
        transition: 'smoothleft',
        minDuration: 26.5,
        beats: [
          {
            caption: 'Progressive load suggestions — log sets and reps in seconds',
            callout: 'Smart progressive overload · Auto weight targets',
            narration: 'During your workout, every lift suggests your next weight. Log your sets and tap finish and save.'
          },
          {
            caption: 'Weight trend, calorie balance, and strength charts update automatically',
            callout: 'Weight trend · Calorie balance · Strength gains',
            narration: 'Switch to the Log tab to see your weight trend, calorie balance, and strength progress update automatically.'
          }
        ]
      },
      {
        id: 'meals',
        label: 'Meals · Photo AI Estimate',
        chapter: '03 · Photo Macro AI',
        transition: 'smoothup',
        minDuration: 19.5,
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
        chapter: '04 · AI Coach Review',
        transition: 'smoothleft',
        minDuration: 22.0,
        beats: [
          {
            caption: 'AI coach reviews your last 14 days and proposes concrete tweaks',
            narration: 'Feel tightness or hit a plateau? Leave a quick note and let the AI coach review your last two weeks.'
          },
          {
            caption: 'Apply for today only, long-term, or decline — undo anytime',
            callout: 'Today only · Long-term · 1-tap undo',
            narration: 'Choose today only, long-term, or decline on any suggestion — and undo with one tap anytime.'
          }
        ]
      },
      {
        id: 'me',
        label: 'Me · Home Screen, Language & Export',
        chapter: '05 · Me & Your Data',
        transition: 'smoothleft',
        minDuration: 16.0,
        beats: [
          {
            caption: 'Switch languages anytime · Add to Home Screen for app-like access',
            callout: 'Safari Share → Add to Home Screen for instant access',
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
      ? `# 薄肌日课（Lean Ritual）产品介绍视频脚本 v3（中文版）`
      : `# Lean Ritual Product Walkthrough Script v3 (English)`
  );
  lines.push('');
  lines.push(
    isZh
      ? `- 目标受众：真实健身用户（非测试说明）\n- 规格：1080×1920 竖屏 & 1920×1080 横屏 · 30fps · H.264 + AAC · 约 2 分钟\n- 配音引擎：${voiceDesc}\n- 音频设计：原创环境电钢背景乐（人声自动闪避）+ 交互点击、转场微风与成功提示音效`
      : `- Audience: Everyday lifters & beta invitees\n- Formats: 1080×1920 vertical & 1920×1080 widescreen · 30fps · H.264 + AAC · ~2 minutes\n- Voiceover: ${voiceDesc}\n- Sound design: Original Rhodes/ambient BGM (sidechain-ducked under voice) + synced UI tap, transition swoosh & chime SFX`
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
