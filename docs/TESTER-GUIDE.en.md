# Lean Ritual Beta Tester Guide

> **Short on time? Read the 2-minute version:** [TESTER-QUICKSTART.en.md](TESTER-QUICKSTART.en.md)

Thanks for helping test **Lean Ritual** (`薄肌日课`)! It is a lightweight web app for tracking daily workouts, meals, and body weight across five bottom tabs: **Today / Meals / Log / Feedback / Me**. It runs directly in your browser (and installs to your home screen)—no Claude account, subscription, or personal API key is needed. If AI is temporarily disabled on the server, every logging feature still works manually.

> **Mainland China testers:** Please **turn OFF any VPN, proxy, or accelerator** and test directly over mobile cellular data (China Mobile / Unicom / Telecom) or regular home Wi-Fi at `https://leanritual.app`. The full walkthrough takes about **15 minutes**.

---

## 1. Accept Your Invite & Sign Up

1. Open the **private invite link** sent to you (it pre-fills your invite code and email; each invite works once for that email only—**do not forward it**).
2. Under **Sign up with invite**, enter a display name and a password of **at least 8 characters**, then tap **Sign up & send verification email**.
3. Open the email titled `Lean Ritual · Verify your email` (or `Lean Ritual · 验证邮箱` if registered in Chinese) and click the link within **1 hour**, then return to `https://leanritual.app` to sign in.
4. **QQ / 163 Mail notes:**
   - First-time delivery may take 1–3 minutes or land in **Spam / Junk / Subscriptions**. Search for `Lean Ritual` or `leanritual.app`.
   - If nothing arrives after 3 minutes, tap **Resend verification email** on the login page and whitelist the sender.
   - Please note **delivery time** and **inbox vs. spam placement**—this is key data for our launch check.

## 2. Install to Your Home Screen (Recommended)

- **iPhone (must use Safari):** Open `https://leanritual.app` → tap **Share** (square with up arrow) → **Add to Home Screen** → **Add**. Launch from the new icon for the full-screen experience.
- **Android (Chrome / Edge / system browser):** Open `https://leanritual.app` → tap the menu `⋮` → **Add to Home screen** or **Install app**.

---

## 3. 15-Minute Test Checklist

Check off each step in order. If a step fails or stalls, note the **time** and take a **screenshot**, then continue with the remaining steps:

- [ ] **1. Access & sign in:** Open `https://leanritual.app` without VPN; confirm no certificate warning. Register via invite, verify email, and sign in (on iPhone, also try opening from the home-screen icon).
- [ ] **2. 1-Minute Setup:** Fill in your baseline stats, training days, and equipment, then tap **Build my plan**.
- [ ] **3. Daily Check-in:** On the **Today** tab, enter weight, steps, or sleep (at least one field) under **Daily Check-in**, tap **Save check-in**, and verify it shows **Logged**.
- [ ] **4. Meal photo + AI estimate:** Open **Meals** → pick a meal type → attach a **non-sensitive food photo** (on iPhone, use a real camera **HEIC** photo; optionally also try a packaged nutrition label) → select **AI estimate** and tap **Save & estimate with AI** (if the server has AI off, switch to **Manual**, save, and note it in your report).
- [ ] **5. Log a workout & reload:** Back on **Today** (if today is a rest day, switch today's session at the top to any workout) → enter weight and reps for at least one set → tap **Finish & save workout** → **reload the page** (or close and reopen) and confirm your workout persists and appears under **Log**.
- [ ] **6. AI feedback → Adopt (Today only) → Undo:** Open **Feedback** → under **Ask AI Coach**, write a brief note (e.g., "Front right shoulder feels tight on bench press, suggest a swap") and tap **Analyze with AI** → tap **Adopt** on a suggestion, inspect the chooser (**Today only / Long-term / Decline**), pick **Today only**, and confirm it applies → tap **Applied · Undo** (or **Undo**) and confirm it reverts (skip and note if AI is disabled).
- [ ] **7. Switch language:** Open **Me** → tap **中文 / English** at top right, browse 1–2 tabs to confirm UI switches cleanly, then switch back.
- [ ] **8. Export data:** Under **Me → Account**, tap **Export my data & photos** and confirm an `.ndjson` file downloads.
- [ ] **9. Password reset email:** Under **Me → Account**, tap **Sign out** → on the sign-in screen tap **Forgot password?** to send a reset email (`Lean Ritual · Reset your password`) → open the link, set a new password, and confirm the **old password fails** while the **new password signs in**.

---

## 4. How to Report Results

- **Fastest way (recommended, under 30 seconds): submit right inside the app.** Go to **Me → Send feedback**, pick **Bug / Idea / Other**, write a brief note, optionally attach **1 screenshot**, leave **Include device info** checked (attaches app version, tab, browser, screen size, language, online status, and time — never health data, meal photos, or your profile), and tap **Send feedback**.
- **Can't sign in?** Tap **Can't sign in? Email feedback** at the bottom of the sign-in page (`hendrix.ai.dev@gmail.com`).
- **Never include passwords, sensitive IDs, or invite/reset tokens from the URL bar in feedback or screenshots.**

If you want to send a full 15-minute walkthrough summary at once, you can also copy and fill out the template below (either in the in-app form or by message):

```text
[Lean Ritual Beta Report]
- Date & time (with timezone):
- City:
- Network & carrier (Mobile / Unicom / Telecom / overseas; cellular or Wi-Fi; VPN OFF confirmed):
- Device / OS / browser (e.g., iPhone 15 / iOS 18.x / Safari):
- Email inbox (QQ / 163 / Gmail / other; verify arrival time & spam?; reset arrival time & spam?):
- Checklist result (1–9 all passed, or failed at step #):
- Error message, slowness (seconds), or screenshot notes:
- Suggestions (optional):
```

---

## 5. Privacy & Deleting Your Account

- **Test data:** Use **realistic but non-sensitive** data and food photos (no IDs, medical reports, faces, or private photos). Online data is hosted on Alibaba Cloud US West (Silicon Valley); see **Me → Privacy Notice** (`https://leanritual.app/privacy.html`) for details.
- **Delete your account:** When finished testing, if you want your data wiped, go to **Me → Account → Delete account → enter your password, check the confirmation box → Delete account permanently**. Deletion permanently removes your account, logs, and photos from the server and **cannot be undone** (export first if you want a copy).
