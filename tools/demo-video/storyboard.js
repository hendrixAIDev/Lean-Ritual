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
      gemini: {
        modelId: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts',
        voiceName: 'Leda',
        stylePrompt: 'cheerful, motivating female fitness coach, energetic and warm, encouraging, natural Mandarin, brisk upbeat pace'
      },
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
      tagline: '一个 App，助你更瘦、更强、更好',
      pills: ['1 分钟定制', '拍照估热量', 'AI 教练'],
      duration: 4.0,
      narration: '薄肌日课：练得更瘦、更强、更好，需要的都在这里。',
      spoken: '薄机日课，练得更瘦更强更好，需要的都在这里。'
    },
    outroCard: {
      eyebrow: 'LEAN RITUAL · 薄肌日课',
      title: '更瘦、更强、更好，从这里开始',
      url: 'https://leanritual.app',
      badge: '邀请制内测',
      footnote: '浏览器打开即用 · 可添加到主屏幕',
      duration: 4.0,
      narration: '薄肌日课，邀请制内测中。',
      spoken: '薄机日课，邀请制内测中。'
    },
    poster: {
      eyebrow: '薄肌日课 · LEAN RITUAL',
      headline: '一个 App，助你更瘦、更强、更好',
      subline: '专属计划 · 拍照估餐 · AI 教练 · 数据随时带走',
      badge: '邀请制内测 · leanritual.app'
    },
    scenes: [
      {
        id: 'setup',
        label: '1 分钟建档 · 专属计划',
        chapter: '01 · 1 分钟定制',
        transition: 'circleopen',
        minDuration: 10.0,
        beats: [
          {
            caption: '1 分钟，填好目标和身体状况',
            callout: '1 分钟 · 伤病也考虑',
            narration: '先花一分钟，说说你的目标和身体状况。'
          },
          {
            caption: '为你定制，AI 持续调整',
            callout: '专属计划 · AI 教练',
            narration: '计划按你的目标和身体定制，AI 教练还会随你进步不断调整。'
          }
        ]
      },
      {
        id: 'checkin',
        label: '今天 · 每日打卡',
        chapter: '02 · 每日打卡',
        transition: 'perspective_swing',
        minDuration: 8.0,
        beats: [
          {
            caption: '每天 10 秒打卡',
            narration: '每天十秒，记下体重、步数和睡眠。'
          },
          {
            caption: '7 天平均，看清趋势',
            callout: '7 天平均 72.4 kg',
            narration: '看七天平均，不被每天的起伏干扰。'
          }
        ]
      },
      {
        id: 'workout_log',
        label: '记训练与记录趋势',
        chapter: '03 · 记训练 & 记录',
        transition: 'perspective_swing',
        minDuration: 9.5,
        beats: [
          {
            caption: '每次训练，告诉你练多重',
            callout: '今天建议 60 kg',
            narration: '每个动作都会建议今天的重量，练完一键保存。'
          },
          {
            caption: '进步一目了然',
            callout: '体重 · 热量 · 力量',
            narration: '体重、热量和力量的变化，都画成曲线。'
          }
        ]
      },
      {
        id: 'meals',
        label: '饮食 · 拍照 AI 估算',
        chapter: '04 · 饮食拍照估算',
        transition: 'perspective_swing',
        minDuration: 9.0,
        beats: [
          {
            caption: '拍张照，AI 帮你算热量',
            narration: '吃饭不用称重，拍张照就行。'
          },
          {
            caption: '几秒出结果',
            callout: '540 kcal · 蛋白质 46.5 g',
            narration: '几秒算出热量和蛋白质，今天还差多少一看就知道。'
          }
        ]
      },
      {
        id: 'coach',
        label: '反馈 · AI 教练与一键撤销',
        chapter: '05 · AI 教练反馈',
        transition: 'perspective_swing',
        minDuration: 9.5,
        beats: [
          {
            caption: 'AI 教练帮你复盘',
            callout: '看两周数据 · 给出调整',
            narration: '进入平台期了？写一句感受，AI 教练看完两周数据给你建议。'
          },
          {
            caption: '一键采纳，随时撤销',
            narration: '喜欢就采纳，不合适随时撤销。'
          }
        ]
      },
      {
        id: 'me',
        label: '我的 · 主屏幕与双语',
        chapter: '06 · 主屏幕 & 双语',
        transition: 'perspective_swing',
        minDuration: 4.8,
        beats: [
          {
            caption: '像 App 一样放在主屏幕',
            callout: '中文 / English',
            narration: '中英文随时切换，还能像 App 一样放在主屏幕。'
          }
        ]
      },
      {
        id: 'export',
        label: '我的 · 一键导出数据',
        chapter: '07 · 数据随时带走',
        transition: 'perspective_swing',
        minDuration: 4.8,
        beats: [
          {
            caption: '你的数据，随时带走',
            callout: '一键导出',
            narration: '记录和照片，一键导出，永远属于你。'
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
      tagline: 'One app to get leaner, stronger, better',
      pills: ['1-Min Setup', 'Photo Calorie AI', 'AI Coach'],
      duration: 4.2,
      narration: 'Lean Ritual: everything you need to get leaner, stronger and better, in one app.'
    },
    outroCard: {
      eyebrow: 'LEAN RITUAL · 薄肌日课',
      title: 'Leaner, stronger, better starts here',
      url: 'https://leanritual.app',
      badge: 'Invite-only beta',
      footnote: 'Works right in your browser · Add to Home Screen',
      duration: 4.0,
      narration: 'Lean Ritual. Now in invite-only beta.'
    },
    poster: {
      eyebrow: 'LEAN RITUAL',
      headline: 'One app to get leaner, stronger, better',
      subline: 'Your plan · Photo calorie AI · AI coach · One-tap export',
      badge: 'Invite-only beta · leanritual.app'
    },
    scenes: [
      {
        id: 'setup',
        label: '1-Minute Setup',
        chapter: '01 · 1-Minute Setup',
        transition: 'circleopen',
        minDuration: 10.0,
        beats: [
          {
            caption: '1 minute: your goal and body',
            callout: '1-minute setup · Injuries included',
            narration: 'Spend one minute on your goal and your body.'
          },
          {
            caption: 'Made for you, tuned by AI',
            callout: 'Your plan · AI coach',
            narration: 'Your plan fits your goal and body, and your AI coach keeps adjusting it as you progress.'
          }
        ]
      },
      {
        id: 'checkin',
        label: 'Today · Daily Check-in',
        chapter: '02 · Daily Check-in',
        transition: 'perspective_swing',
        minDuration: 8.0,
        beats: [
          {
            caption: '10-second daily check-in',
            narration: 'Ten seconds a day: weight, steps, sleep.'
          },
          {
            caption: '7-day average shows the trend',
            callout: '7-day avg 72.4 kg',
            narration: 'Watch the 7-day average, not the daily ups and downs.'
          }
        ]
      },
      {
        id: 'workout_log',
        label: 'Workouts & Progress',
        chapter: '03 · Workouts & Progress',
        transition: 'perspective_swing',
        minDuration: 11.5,
        beats: [
          {
            caption: 'Know what weight to lift',
            callout: 'Today: 60 kg',
            narration: "Each lift suggests today's weight. Log it in one tap."
          },
          {
            caption: 'See your progress',
            callout: 'Weight · Calories · Strength',
            narration: 'Weight, calories and strength, all in clear charts.'
          }
        ]
      },
      {
        id: 'meals',
        label: 'Meals · Photo Estimate (AI)',
        chapter: '04 · Meal Photo AI',
        transition: 'perspective_swing',
        minDuration: 10.5,
        beats: [
          {
            caption: 'Snap a photo, AI counts it',
            narration: 'No scales. Just snap your meal.'
          },
          {
            caption: 'Results in seconds',
            callout: '540 kcal · 46.5 g protein',
            narration: "Calories and protein in seconds, so you know what's left today."
          }
        ]
      },
      {
        id: 'coach',
        label: 'Feedback · AI Coach',
        chapter: '05 · AI Coach',
        transition: 'perspective_swing',
        minDuration: 10.5,
        beats: [
          {
            caption: 'Your AI coach checks in',
            callout: '2-week review · Clear tweaks',
            narration: 'Stuck? Write one line, and your AI coach reviews two weeks and suggests fixes.'
          },
          {
            caption: 'Apply in a tap. Undo anytime.',
            narration: 'Like it? Apply it. Changed your mind? Undo.'
          }
        ]
      },
      {
        id: 'me',
        label: 'Me · Home Screen & Language',
        chapter: '06 · Home Screen & Language',
        transition: 'perspective_swing',
        minDuration: 4.8,
        beats: [
          {
            caption: 'Add it to your home screen',
            callout: '中文 / English',
            narration: 'Switch languages anytime, and keep it on your home screen like an app.'
          }
        ]
      },
      {
        id: 'export',
        label: 'Me · One-Tap Data Export',
        chapter: '07 · Your Data',
        transition: 'perspective_swing',
        minDuration: 4.8,
        beats: [
          {
            caption: 'Your data, yours to keep',
            callout: 'One-tap export',
            narration: "Export everything in one tap. It's always yours."
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
      ? `# 薄肌日课（Lean Ritual）产品介绍视频脚本 v10（中文版）`
      : `# Lean Ritual Product Walkthrough Script v10 (English)`
  );
  lines.push('');
  lines.push(
    isZh
      ? `- 目标受众：真实健身用户（非测试说明）\n- 规格：1080×1920 竖屏 & 1920×1080 横屏 · 30fps · H.264 + AAC · 约 1 分 40 秒\n- 配音引擎：${voiceDesc}\n- 音频设计：原创 116 BPM 活力电子电钢背景乐（人声自动闪避）+ 节拍转场冲击、交互点击与提示音效`
      : `- Audience: Everyday lifters & beta invitees\n- Formats: 1080×1920 vertical & 1920×1080 widescreen · 30fps · H.264 + AAC · ~1:30–1:45\n- Voiceover: ${voiceDesc}\n- Sound design: Original upbeat 116 BPM synth-Rhodes BGM (sidechain-ducked under voice) + beat-synced transition impact, UI tap & chime SFX`
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
