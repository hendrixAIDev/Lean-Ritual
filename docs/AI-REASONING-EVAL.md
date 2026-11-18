# AI Reasoning Effort Evaluation (`google/gemini-3.8-flash`)

**Date:** 2026-11-18 (UTC)  
**Model & Endpoint:** `google/gemini-3.8-flash` via OpenRouter (`https://openrouter.ai/api/v1/chat/completions`, provider `Google`)  
**Production Baseline:** `AI_MAX_OUTPUT_TOKENS=6000`, `AI_REASONING_EFFORT` unset, JSON mode (`response_format: {"type": "json_object"}`)  
**Evaluation Spend:** **US$0.114739** across 23 live calls (budget cap: < US$1.00; zero production config changes or restarts)

## Executive Recommendation

**Recommend setting `AI_REASONING_EFFORT=low`** in `/etc/bojin/environment` (paired optionally with lowering `AI_MAX_OUTPUT_TOKENS` from `6000` to `2000`).

- **Cost drops 66.9% overall** across the 10-case benchmark (**$0.589 → $0.195 per 100 calls**), and **75.6% on everyday meal & exercise-swap calls** (**$0.498 → $0.121 per 100 calls**), because OpenRouter maps `effort: "low"` on `google/gemini-3.8-flash` to `0` reasoning tokens instead of ~1,075 billed thinking tokens per call ($3.75/1M completion rate).
- **Latency drops 3.2×** overall (**mean 12.75 s → 3.97 s**, **median 10.67 s → 3.36 s**). Meal and swap calls consistently return in **2.9–3.7 s** instead of **6.6–13.5 s**, and 4k-token 14-day feedback analyses drop from **13.2–32.3 s** to **5.3–8.4 s**.
- **Reliability & quality stay at parity:** `low` achieved **10/10 strict valid JSON**, **10/10 `app/index.html` schema compliance**, **4.03% mean calorie error** (vs **4.52%** unset; **7.17%** vs **5.10%** across all 24 macro estimates), and **4.8/5 mean quality** (vs **4.9/5** unset).
- **Do not use `medium`:** On `google/gemini-3.8-flash`, `medium` used as many reasoning tokens as `unset` (mean **1,110** vs **1,025** on the matched 3-case subset), saved neither cost nor latency, and suffered a post-JSON runaway decoding loop on `F1` (`finish_reason="length"` at 5,996 completion tokens, 53.6 s, $0.0254), which `public/shim.js` surfaces as a hard truncation failure.

---

## Method & Synthetic Benchmark

All calls were executed from the production host (`leanritual`) so wall-clock latencies reflect actual host-to-OpenRouter round trips, reading `OPENROUTER_API_KEY`, `OPENROUTER_BASE`, `OPENROUTER_MODEL`, and `AI_MAX_OUTPUT_TOKENS` read-only from `/etc/bojin/environment` via a `systemd.exec(5)`-compatible `EnvironmentFile` parser. Temporary script files in `/tmp` were removed immediately after collection.

Requests reproduced `lib/ai.js` (`createAIProxy` with `json: true`) and the exact prompt builders in `app/index.html`:
1. **`estimateMeal` (`app/index.html:2462–2477`):** Text-only (`withImg = false`), synthetic male cutting profile (`targets()`: 74 kg, 15.5% BF, 1,970 kcal, 163 g P, 213 g C, 52 g F).
2. **`aiSuggest` (`app/index.html:2091–2099`):** 3-item JSON array swap prompt checked against `Array.isArray(r)`.
3. **`runAI` + `dataDigest` (`app/index.html:2892–2940`):** `GUIDE_TEXT` + synthetic 14-day check-in/workout/meal digest, checked against `app/index.html`'s canonical `PROGRAM` `from`-exercise filter.

### Pre-Registered Synthetic Cases & Reference Justifications

| Case | Type | Synthetic Input Summary | Reference Macros / Target Constraints (Justification) |
| :--- | :--- | :--- | :--- |
| **M1** | Meal (ZH) | `熟米饭 200g + 食堂宫保鸡丁一份（约 200g，鸡胸肉为主、少量花生和葱段）` | **640 kcal, 41.0P, 65.0C, 26.0F** — CFCT/USDA: 200 g cooked white rice (232 kcal, 5.2P, 51.8C, 0.6F) + 200 g canteen Kung Pao chicken (~120 g raw breast, 20 g peanuts, ~12 g oil, starch glaze: ~408 kcal, 35.8P, 13.2C, 25.4F). |
| **M2** | Meal (ZH) | `兰州牛肉拉面一碗（普通份量约二两干面/煮熟260g，几片薄牛肉约40g，清汤喝了一半，没加辣油）` | **475 kcal, 24.5P, 75.0C, 8.5F** — ~100 g dry / 260 g cooked pulled wheat noodles (~350 kcal, 11P, 73C, 1.5F) + 40 g cooked beef shank (~80 kcal, 12P, 3.5F) + half clear broth (~45 kcal, 1.5P, 2C, 3.5F). |
| **M3** | Meal (ZH) | `生燕麦片 60g 用无糖脱脂牛奶 250mL 煮粥，加水煮全蛋 2 个（中等大小）` | **460 kcal, 29.0P, 53.7C, 14.0F** — USDA: 60 g dry rolled oats (227 kcal, 7.9P, 40.6C, 3.9F) + 250 mL skim milk (88 kcal, 8.5P, 12.3C, 0.3F) + 2 medium boiled eggs ~100 g (144 kcal, 12.6P, 0.8C, 9.8F). |
| **M4** | Meal (ZH) | `外卖骨汤麻辣烫一碗：瘦牛肉卷80g、老豆腐100g、娃娃菜和金针菇150g、红薯粉丝一小把（干重约50g），微麻酱（约一汤匙15g），没喝汤` | **585 kcal, 32.2P, 54.8C, 26.5F** — 80 g lean beef (140 kcal, 16P, 8F) + 100 g firm tofu (98 kcal, 10.5P, 2.5C, 5F) + 150 g veg/enoki (35 kcal, 2.5P, 6.5C) + 50 g dry sweet-potato vermicelli (175 kcal, 43C) + 15 g sesame paste & ~5 g clinging broth oil (138 kcal, 3P, 2.8C, 13F). |
| **M5** | Meal (EN) | `180g cooked skinless chicken breast, 150g cooked jasmine rice, 120g steamed broccoli, and 1 tbsp (14g) extra-virgin olive oil drizzled on top` | **658 kcal, 62.7P, 50.9C, 21.4F** — USDA: 180 g cooked breast (297 kcal, 55.8P, 6.5F) + 150 g cooked jasmine rice (195 kcal, 4.0P, 42.3C, 0.4F) + 120 g broccoli (42 kcal, 2.9P, 8.6C, 0.5F) + 14 g EVOO (124 kcal, 14.0F). |
| **M6** | Meal (EN) | `2 slices sourdough bread (80g total), half a medium Hass avocado (75g), 3 scrambled large eggs cooked in 5g butter, and a protein shake (label: 120 kcal, 24g P, 3g C, 1.5g F)` | **709 kcal, 53.0P, 52.0C, 32.8F** — USDA + label: 80 g sourdough (218 kcal, 8.6P, 41.5C, 1.4F) + 75 g avocado (120 kcal, 1.5P, 6.4C, 11.0F) + 3 large eggs (215 kcal, 18.9P, 1.1C, 14.8F) + 5 g butter (36 kcal, 4.1F) + 1 scoop whey (120 kcal, 24P, 3C, 1.5F). |
| **S1** | Swap | Replace `引体向上（能做 6 个后负重）` on Pull day (`硬拉、杠铃划船、面拉、二头弯举`); gym; `<1 yr` exp; left lateral epicondylitis; `0` pull-ups & **no assisted pull-up machine** | Return 3-element JSON array; vertical-pull / lat target; **no** assisted pull-up machine or unassisted pull-ups; neutral/elbow-friendly grip; avoid duplicating `杠铃划船`. |
| **S2** | Swap | Replace `杠铃划船` on Pull day (`杠铃臀推、引体向上、面拉、二头弯举`); gym; `1–3 yr` exp; **L4–L5 disc protrusion** | Return 3-element JSON array; horizontal/mid-back row with **chest/bench support** unloading lumbar shear; compound 4–8 rep range. |
| **F1** | Feedback | 14-day cut digest (Week 6): weight stalled at `76.1 → 76.0 kg` (<0.5%/wk), right anterior knee pain on squats (`95 kg`), ~5,800 steps/d, ~135 g P vs 167 g target, ~2,180 kcal actual vs 2,020 target | Address knee pain + medical caveat first; valid canonical `swap` (`from: "深蹲"`); cite actual intake/steps/protein numbers; calibrate deficit (`-100` to `-150 kcal` and/or `+2,000+` steps per `GUIDE_TEXT`). |
| **F2** | Feedback | 14-day cut digest (Week 9, English user note): rapid loss `71.9 → 69.9 kg` (>1%/wk), all lifts dropping, ~1,680 kcal actual (~790 kcal deficit), ~5.9 h sleep, shoulder/wrist ache | Respond in Chinese per schema; trigger **`deload`** (Week 9 + multi-lift drop + joint/sleep fatigue) **and** **`kcal` increase** (`+100` to `+150 kcal` per >1%/wk loss + strength-drop rule); medical caveat for joint pain. |

---

## Aggregate Results

Observed OpenRouter pricing on `google/gemini-3.8-flash` was exact across all calls at **$0.75 / 1M prompt tokens** and **$3.75 / 1M completion tokens** (billed on `visible + reasoning` tokens).

| Subset & Setting | Calls | Valid JSON (`app` OK) | `stop` / `length` | Mean Prompt Tok | Mean Reason Tok | Mean Visible Tok | Total Spend (USD) | Cost / 100 Calls | Latency Mean / Med (Min–Max) | Meal MAPE kcal / All 4 | Mean Quality (1–5) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **All 10 Cases — `unset`** | 10 | 10/10 (10/10) | 10 / 0 | 1,070 | 1,075 | 282 | $0.058915 | **$0.589** | 12.75 s / 10.67 s (6.58–32.33 s) | 4.52% / 5.10% | **4.9 / 5.0** |
| **All 10 Cases — `low`** | 10 | 10/10 (10/10) | 10 / 0 | 1,070 | **0** | 306 | $0.019490 | **$0.195** (-66.9%) | **3.97 s / 3.36 s** (2.87–8.36 s) | **4.03%** / 7.17% | **4.8 / 5.0** |
| └─ *Meals + Swaps (`M1–M6, S1–S2`) — `unset`* | 8 | 8/8 (8/8) | 8 / 0 | 321 | 1,036 | 227 | $0.039810 | **$0.498** | 10.25 s / 10.33 s (6.58–13.54 s) | 4.52% / 5.10% | 4.9 / 5.0 |
| └─ *Meals + Swaps (`M1–M6, S1–S2`) — `low`* | 8 | 8/8 (8/8) | 8 / 0 | 321 | **0** | 260 | $0.009709 | **$0.121** (-75.6%) | **3.26 s / 3.28 s** (2.87–3.71 s) | 4.03% / 7.17% | 4.8 / 5.0 |
| └─ *14d Feedback (`F1–F2`) — `unset`* | 2 | 2/2 (2/2) | 2 / 0 | 4,069 | 1,232 | 502 | $0.019105 | **$0.955** | 22.77 s / 22.77 s (13.21–32.33 s) | — | 5.0 / 5.0 |
| └─ *14d Feedback (`F1–F2`) — `low`* | 2 | 2/2 (2/2) | 2 / 0 | 4,069 | **0** | 491 | $0.009782 | **$0.489** (-48.8%) | **6.82 s / 6.82 s** (5.29–8.36 s) | — | 5.0 / 5.0 |
| **Matched 3 Cases (`M4, S1, F1`) — `unset`** | 3 | 3/3 (3/3) | 3 / 0 | 1,519 | 1,025 | 333 | $0.018687 | **$0.623** | 11.40 s / 11.97 s (9.03–13.21 s) | — | 5.0 / 5.0 |
| **Matched 3 Cases (`M4, S1, F1`) — `low`** | 3 | 3/3 (3/3) | 3 / 0 | 1,519 | **0** | 323 | $0.007047 | **$0.235** (-62.3%) | **3.99 s / 3.43 s** (3.26–5.29 s) | — | 4.7 / 5.0 |
| **Matched 3 Cases (`M4, S1, F1`) — `medium`** | 3 | **2/3 (2/3)** | **2 / 1** | 1,519 | 1,110 | 1,816 | $0.036335 | **$1.211** (+94.5%) | 25.54 s / 12.89 s (10.12–53.62 s) | — | **3.3 / 5.0** |
| **Grand Total (All Evaluation Calls)** | **23** | **22/23** | **22 / 1** | — | — | — | **$0.114739** | — | — | — | — |

---

## Per-Case × Setting Metrics & Quality

Token columns show `Prompt / Reasoning / Visible Output (Total Completion)`. For meals, macro errors are `|est − ref| / ref` for `kcal / P / C / F`.

| Case | Effort | Valid JSON | Finish | Tokens (`P / R / V (C)`) | Cost (`usage.cost`) | Latency | Output Summary & Macro Abs % Error | Score | Justification |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :---: | :--- |
| **M1** | `unset` | Yes | `stop` | `329 / 1158 / 210 (1368)` | $0.00538 | 10.22 s | `607 kcal, 35.2P, 63.8C, 23.1F` (`5.2% / 14.1% / 1.8% / 11.2%`) | **5** | Realistic canteen oil/peanut breakdown; accurate rice math; practical oil-draining tip. |
| **M1** | `low` | Yes | `stop` | `329 / 0 / 230 (230)` | $0.00111 | 3.05 s | `612 kcal, 36.2P, 65.8C, 23.1F` (`4.4% / 11.7% / 1.2% / 11.2%`) | **5** | Slightly closer to reference than `unset`; exact internal sum; clear oil + leafy-veg tip. |
| **M2** | `unset` | Yes | `stop` | `337 / 902 / 234 (1136)` | $0.00451 | 10.44 s | `425 kcal, 23.0P, 62.0C, 8.2F` (`10.5% / 6.1% / 17.3% / 3.5%`) | **4** | Respected 40 g beef, half broth, no chili oil, and <30 g protein warning; noodle carbs conservative. |
| **M2** | `low` | Yes | `stop` | `337 / 0 / 203 (203)` | $0.00101 | 3.30 s | `430 kcal, 21.0P, 59.0C, 11.5F` (`9.5% / 14.3% / 21.3% / 35.3%`) | **4** | Calorie error 9.5% and flagged <30 g protein; +3.0 g higher beef/broth fat assumption than ref. |
| **M3** | `unset` | Yes | `stop` | `329 / 907 / 237 (1144)` | $0.00454 | 9.29 s | `457 kcal, 28.9P, 53.0C, 13.7F` (`0.7% / 0.3% / 1.3% / 2.1%`) | **5** | Near-exact match (≤2.1% on every macro); properly treated 60 g oats as dry weight. |
| **M3** | `low` | Yes | `stop` | `329 / 0 / 248 (248)` | $0.00118 | 3.04 s | `453 kcal, 30.1P, 50.2C, 14.3F` (`1.5% / 3.8% / 6.5% / 2.1%`) | **5** | All 4 macros within ≤6.5%; properly distinguished dry oats and skim milk. |
| **M4** | `unset` | Yes | `stop` | `357 / 1164 / 255 (1419)` | $0.00559 | 9.03 s | `537 kcal, 33.9P, 50.5C, 22.1F` (`8.2% / 5.3% / 7.8% / 16.6%`) | **5** | Explicitly modeled unconsumed soup + 4 g clinging oil + 15 g sesame paste; good sauce swap tip. |
| **M4** | `low` | Yes | `stop` | `357 / 0 / 316 (316)` | $0.00145 | 3.26 s | `555 kcal, 29.2P, 50.5C, 24.2F` (`5.1% / 9.3% / 7.8% / 8.7%`) | **5** | Closest to reference on all 4 macros (<10% error each), including 5 g clinging broth oil. |
| **M4** | `medium` | Yes | `stop` | `357 / 1043 / 257 (1300)` | $0.00514 | 10.12 s | `534 kcal, 33.9P, 51.5C, 20.4F` (`8.7% / 5.3% / 6.0% / 23.0%`) | **4** | Good breakdown and vinegar/soy sauce tip, but underestimated fat in beef rolls + clinging oil. |
| **M5** | `unset` | Yes | `stop` | `339 / 670 / 257 (927)` | $0.00373 | 6.58 s | `658 kcal, 62.8P, 50.6C, 21.5F` (`0.0% / 0.2% / 0.6% / 0.5%`) | **5** | Textbook USDA accuracy (≤0.6% across all macros); tailored oil/protein split tip to 52 g fat goal. |
| **M5** | `low` | Yes | `stop` | `339 / 0 / 273 (273)` | $0.00128 | 3.71 s | `658 kcal, 63.1P, 50.4C, 20.5F` (`0.0% / 0.6% / 1.0% / 4.2%`) | **5** | Exact 658 kcal and ≤4.2% on all macros; clean Chinese item translation and budget tip. |
| **M6** | `unset` | Yes | `stop` | `366 / 1324 / 288 (1612)` | $0.00632 | 13.54 s | `691 kcal, 51.4P, 50.5C, 33.0F` (`2.5% / 3.0% / 2.9% / 0.6%`) | **5** | Extracted English scoop label accurately; all macros ≤3.0%; smart post-workout fat tip. |
| **M6** | `low` | Yes | `stop` | `366 / 0 / 320 (320)` | $0.00147 | 3.42 s | `683 kcal, 51.5P, 48.9C, 32.8F` (`3.7% / 2.8% / 6.0% / 0.0%`) | **5** | Exact 32.8 g fat and English scoop label extraction; all macros ≤6.0%. |
| **S1** | `unset` | Yes | `stop` | `254 / 1060 / 172 (1232)` | $0.00481 | 11.97 s | `对握高位下拉 3×6–8` / `单臂绳索高位下拉 3×6–8` / `绳索直臂下压 3×10–12` | **5** | Valid root JSON array; respected no-assisted-machine, 0-rep scalability, and lateral-elbow grip safety. |
| **S1** | `low` | Yes | `stop` | `254 / 0 / 241 (241)` | $0.00109 | 3.43 s | `高位下拉（对握V柄） 3×6–8` / `反手高位下拉 3×6–8` / `直臂下压（绳索） 3×8–12` | **4** | Valid root array; avoided assisted machine & pronated grip; supinated pulldown is good though slightly less neutral on elbow than single-arm cable. |
| **S1** | `medium` | Yes | `stop` | `254 / 1314 / 168 (1482)` | $0.00575 | 12.89 s | `对握高位下拉 3×6–8` / `单臂绳索下拉 3×6–8` / `绳索直臂下压 3×10–12` | **5** | Identical exercise selection and rep compliance to `unset`, at higher token cost. |
| **S2** | `unset` | Yes | `stop` | `254 / 1099 / 166 (1265)` | $0.00493 | 10.90 s | `胸托器械划船 3×6–8` / `上斜胸托哑铃划船 3×6–8` / `胸托T杠划船 3×5–8` | **5** | Valid root array; all 3 swaps use explicit chest support unloading L4–L5 shear in 5–8 rep range. |
| **S2** | `low` | Yes | `stop` | `254 / 0 / 245 (245)` | $0.00111 | 2.87 s | `胸部支撑T杠划船 3×6–8` / `胸部支撑哑铃划船 3×6–8` / `坐姿器械划船 3×6–8` | **5** | Valid root array; all 3 swaps specify chest-pad support (`胸垫提供刚性支撑`) and 6–8 compound reps. |
| **F1** | `unset` | Yes | `stop` | `3945 / 850 / 571 (1421)` | $0.00829 | 13.21 s | `swap(深蹲→箱式深蹲 3×4–6)`, `kcal(-120)`, `note(steps+protein)` | **5** | Prioritized knee pain + medical caveat; cited `76.0 kg`, `5800` steps, `130–145 g` P; valid canonical `from`. |
| **F1** | `low` | Yes | `stop` | `3945 / 0 / 411 (411)` | $0.00450 | 5.29 s | `swap(深蹲→箱式深蹲 3×6–8)`, `note(steps 8k–10k)`, `note(protein +30g)` | **5** | Prioritized knee pain + medical caveat; cited `~5800` steps & `~135 g` P; smartly fixed step/dining compliance before cutting target kcal. |
| **F1** | `medium` | **No** | **`length`** | `3945 / 974 / 5022 (5996)` | **$0.02544** | **53.62 s** | Truncated at `max_tokens=6000` (unclosed JSON followed by unrelated exam text) | **1** | Failed before final `]}` with runaway pretraining text; rejected by `public/shim.js` (`r.truncated`). |
| **F2** | `unset` | Yes | `stop` | `4193 / 1613 / 433 (2046)` | $0.01082 | 32.33 s | `deload`, `kcal(+150)`, `swap(站姿杠铃推举→坐姿哑铃对握推举)`, `note(sleep+caffeine)` | **5** | Answered EN note in ZH; caught both `deload` and `+150 kcal` rules plus afternoon caffeine vs sleep. |
| **F2** | `low` | Yes | `stop` | `4192 / 0 / 570 (570)` | $0.00528 | 8.36 s | `deload`, `kcal(+150)`, `note(refeed 2480 kcal + sleep ≥7h + medical caveat)` | **5** | Answered EN note in ZH; caught `deload`, `+150 kcal` (`71.9→69.9 kg`, `~1680 kcal`), and Week >8 refeed; missed only afternoon caffeine note. |

---

## Why `low` Retains Accuracy & Key Risk Notes

1. **Inline `"calc"` scratchpad preserves meal math without thinking tokens:** In `estimateMeal` (`app/index.html:2476`), the JSON schema places `"items"` and `"calc"` *before* `"kcal"`, `"protein"`, `"carbs"`, and `"fat"`. Even with `reasoning_tokens = 0`, the model writes per-ingredient gram and macro math into `"calc"` before emitting totals, keeping calorie MAPE at **4.03%**.
   - **Risk (Photo & Nutrition-Label Vision Calls):** This evaluation tested text prompts only. Photo calls (`withImg = true`) that read skewed packaging nutrition tables (`kJ ÷ 4.184 × serving weight`) or compare before/after plates (`cmp = true`) still benefit from `"calc"` preceding `"kcal"`, but zero-thinking vision arithmetic has less self-correction margin than text lookup. After enabling `AI_REASONING_EFFORT=low`, spot-check 3–5 real photo-label meals; if kJ/serving conversion slips appear, only photo calls would warrant higher effort.
2. **Subtle cross-field synthesis in 14-day feedback:** On `F2`, `low` caught every core `GUIDE_TEXT` rule (`deload`, `+150 kcal` for >1%/wk loss with strength drop, Week >8 maintenance refeed, sleep deficit, medical warning) in 8.4 s vs 32.3 s, missing only the secondary interaction between `时段:下午` and `补剂:咖啡因`. That tradeoff is well worth removing 20–30 s waits and halving cost.
3. **Runaway decoding & `AI_MAX_OUTPUT_TOKENS` sizing:** `F1` under `medium` demonstrated that `google/gemini-3.8-flash` in `json_object` mode can occasionally fail to emit the closing `]}` and stream unrelated text until hitting `max_tokens=6000` ($0.0254 and 53.6 s wasted on a single failed call). Because `low` uses `0` reasoning tokens and never exceeded **570 completion tokens** across any prompt type, lowering `AI_MAX_OUTPUT_TOKENS` from `6000` back to the `server.js` default of **`2000`** alongside `AI_REASONING_EFFORT=low` safely bounds worst-case runaway cost/latency by 3× without risking legitimate truncation. *(Do not lower `AI_MAX_OUTPUT_TOKENS` below `2500` while `AI_REASONING_EFFORT` remains unset, as `F2 unset` legitimately used `2,046` total completion tokens.)*
4. **Provider mapping & `aiSuggest` array schema:**
   - OpenRouter currently translates `reasoning: {"effort": "low"}` on `google/gemini-3.8-flash` to `0` thinking tokens; future Gemini model upgrades could map `low` to a small non-zero thinking budget (still strictly cheaper and faster than `unset`). Monitor `reasoning=` and `finish_reason=` in `bojin.service` `ai kind=json` journal lines after rollout.
   - `aiSuggest` (`app/index.html:2099–2103`) requests a root JSON array (`[...]`) while `lib/ai.js` sends `response_format: {"type": "json_object"}`. `google/gemini-3.8-flash` returned a bare JSON array on 5/5 swap calls across `unset`, `low`, and `medium`, because Gemini maps `json_object` to `response_mime_type: "application/json"`. Keep this in mind if switching to an OpenAI-family model that enforces `{...}` object roots.
