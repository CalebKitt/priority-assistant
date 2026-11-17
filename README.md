# Priority Assistant

A Chrome extension for **Gmail and Outlook on the web** plus a **phone web app** that learn how you handle email and sort your inbox by priority instead of recency. Built from Group 11's [clickable MVP](https://calebnwaite.github.io/inbox-priority-prototype/#/desktop), now running on real mailboxes.

Setup for real accounts: [docs/SETUP.md](docs/SETUP.md). To look around first: `npm install && npm run dev`, then open http://localhost:5173/ (phone) and http://localhost:5173/dev/ (desktop overlay), both on the demo inbox.

## What it does

**Learns your habits** (state chart C: shadow mode, then 85% match, then assisting)
- On first connect it studies the last 60 days: who you reply to and how fast, what you forward and to whom, what you skip, trash or file, and what lives in each of your existing folders.
- It keeps watching through the Gmail/Outlook APIs, so actions you take in the native apps or on your phone count too. "Read" is not "handled": an email stays in Priority until you reply, forward or mark it done (Jeff).
- Learning mode changes nothing. It guesses silently and compares with what you actually do. Suggestions and auto-filing turn on at 85% match.

**Desktop (Chrome extension)**
- A **Priority inbox** drawn over the native list: ranked and color-coded (red = urgent, orange = important), each with a one-line reason ("You usually answer Corey within the hour"). Everything else is sorted by likelihood or by date. One click goes back to the normal view.
- A **sidebar** with Next move, Up next, Due this week (calendar of reminders, due dates found in email, and follow-up nudges for submittals), Moved for you (every auto-move with Undo), and Sorting confidence with "Why this order?".
- Its own reading view with "This email" (headline, key points, next step), drafted replies in your style, forward suggestions learned from your history, reminders, and "Always prioritize [sender]" (Rick, Max).
- A **CC folder**: emails you're only copied on are filed there, one row per conversation, each with a "Where did this end up?" summary (Rick's long vendor threads).
- **Folders learned from yours**: it auto-files mail into the folders you already use (job sites, vendors, newsletters) once confident.
- Priority shows up as **color labels/categories** in Gmail and Outlook themselves, so it's visible in any mail app.

**Phone (web app, add to home screen)**
- **Inbox**: the same priority ranking.
- **Sort**: swipe right = Priority, left = Trash (with Undo), up = Forward (to the suggested person), down = Later. Two swipes the same way for one sender offers an "always" rule.
- **Speak** (hands-free for the drive home): reads each priority email aloud. Say "reply ...", "next", "repeat", "read it all", "remind me tomorrow", "forward to Thomas", "priority", "later", "trash", or "stop". It reads the reply back and sends only when you say "send". There's also "Read my daily brief".
- **Summary**: the daily brief, due this week, and an "ask about your email" chat.

**Trust rules (from interview feedback)**
- Never sends, replies or forwards on its own.
- An "Are you sure?" check before anything with attachments, money or bank words, or outside recipients (Steven).
- Never files away anything it ranks as priority, and every move can be undone. Undo teaches it.
- "What can I ignore" became "Everything else" plus the "Moved for you" log (Max).

## How it fits together

```
Gmail page / Outlook page                         Phone web app (PWA)
  content.ts  -> overlay + sidebar (ui/app.ts)       screens: inbox, sort, speak, summary
        | chrome.runtime messages                          |
  background.ts (service worker)                           |
        +------------------ core/ (shared) -----------------+
            service.ts   ranking, learning, auto-file, view model
            learn/       features, priority (logistic regression), folders (naive Bayes), forwards
            providers/   gmail.ts (Gmail API), outlook.ts (Microsoft Graph), demo.ts
            state.ts     per-account state; conflict-free merge for cross-device sync
            ai.ts        Gemini prompts (next step, drafts, thread summaries, brief, chat, voice cleanup)
                |                                  |
     user's Drive appDataFolder /          proxy/worker.ts (Cloudflare)
     OneDrive app folder (learned data)    OAuth code exchange + team Gemini key for allowlisted testers
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Builds `dist/extension` and `dist/mobile` from `config.json` |
| `npm run dev` | Rebuilds on change and serves the phone app and desktop demo on :5173 |
| `npm test` | Learning-engine tests against the demo mailbox |
| `npm run typecheck` | TypeScript check |
| `npm run keygen` | Pins the extension ID (run once) |
