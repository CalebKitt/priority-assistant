# Setup: from demo to real Gmail and Outlook

You can try everything with the **demo inbox** right away (steps 1–3). Real accounts need four things only you can create: a Google Cloud project, a Microsoft app registration, a Gemini API key, and a Cloudflare account for the small proxy. Plan on about an hour the first time.

## 1. Build

Needs Node.js 20 or newer.

```bash
npm install
```

```bash
npm run keygen
```

`keygen` creates `config.json` (from `config.example.json`) and pins the extension's ID so its sign-in redirect URL never changes. It prints two things you'll need below:

- **Extension ID**, e.g. `abcdefghijklmnopabcdefghijklmnop`
- **Redirect URL**, `https://<extension id>.chromiumapp.org/`

```bash
npm run build
```

## 2. Load the extension in Chrome

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `dist/extension` folder.
3. The settings page opens. Tick **Demo inbox** to look around with sample construction email, then open Gmail or Outlook on the web.

After every `npm run build`, click the reload icon on the extension card, then reload your Gmail/Outlook tab.

## 3. Try the phone app and desktop demo locally

```bash
npm run dev
```

- Phone app: http://localhost:5173/ (use your browser's device toolbar, or open it from your phone on the same Wi-Fi using your computer's IP)
- Desktop overlay demo without the extension: http://localhost:5173/dev/

## 4. Google (Gmail)

In [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project (e.g. "Priority Assistant").
2. **APIs & Services → Library**: enable **Gmail API** and **Google Drive API**.
3. **Google Auth Platform → Branding / Audience**: user type **External**, publishing status **Testing**. Under **Test users**, add every tester's Gmail address (up to 100).
4. **Data Access → Add scopes**: `openid`, `email`, `profile`, `.../auth/gmail.modify`, `.../auth/drive.appdata`.
5. **Clients → Create client → Web application**. Under **Authorized redirect URIs** add:
   - `https://<extension id>.chromiumapp.org/`
   - `http://localhost:5173/`
   - your hosted phone app URL from step 8, e.g. `https://priority-assistant.pages.dev/`
6. Copy the **Client ID** and **Client secret**.

Notes:
- While the app is in Testing, Google ends sign-ins after 7 days. Testers just click **Connect Gmail** again.
- `gmail.modify` is a "restricted" scope. That's fine for named testers. A public release would need Google's verification and a paid security assessment.

## 5. Microsoft (Outlook, work and personal)

In the [Azure portal](https://portal.azure.com/) → **Microsoft Entra ID → App registrations → New registration**:

1. Name: Priority Assistant. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
2. **Authentication → Add a platform → Web** (not "Single-page application") and add the same three redirect URIs as Google.
3. **Certificates & secrets → New client secret**. Copy the secret's **Value** right away.
4. **API permissions → Add → Microsoft Graph → Delegated**: `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`, `Files.ReadWrite.AppFolder`, `offline_access`, `openid`, `email`, `profile`.
5. Copy the **Application (client) ID** from Overview.

Work accounts: some companies only allow apps their IT admin approved. If a tester sees "Need admin approval", their IT admin must grant consent for this app.

## 6. Gemini key

Create a key at [Google AI Studio](https://aistudio.google.com/apikey). On the free tier Google may use prompts to improve its products. Turn on billing for that project if you don't want tester email used that way. Testers can also paste their own key in Settings, which bypasses the proxy.

## 7. Deploy the proxy (Cloudflare Worker)

The proxy holds the Google/Microsoft client secrets and your Gemini key, and only answers allowlisted testers.

```bash
cd proxy
```

```bash
npx wrangler login
```

Set the five secrets (each command prompts for the value):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

```bash
npx wrangler secret put MICROSOFT_CLIENT_ID
```

```bash
npx wrangler secret put MICROSOFT_CLIENT_SECRET
```

```bash
npx wrangler secret put GEMINI_API_KEY
```

Edit `proxy/wrangler.toml`:

- `ALLOWED_EMAILS`: testers allowed to use your Gemini key, e.g. `jeff@brester.com,@pillenfarms.com` (a leading `@` allows a whole domain).
- `ALLOWED_ORIGINS`: `chrome-extension://<extension id>,http://localhost:5173,https://priority-assistant.pages.dev`

```bash
npx wrangler deploy
```

It prints a URL like `https://priority-assistant-proxy.<you>.workers.dev`. Check it with `/health` on the end.

## 8. Host the phone app

Cloudflare Pages is the simplest since you already have wrangler. From the project root:

```bash
npm run build
```

```bash
npx wrangler pages deploy dist/mobile --project-name priority-assistant
```

The URL (e.g. `https://priority-assistant.pages.dev/`) must be in both redirect URI lists (steps 4 and 5) and in `ALLOWED_ORIGINS`.

## 9. Fill in config.json and rebuild

```json
{
  "googleClientId": "<from step 4>",
  "microsoftClientId": "<from step 5>",
  "proxyUrl": "https://priority-assistant-proxy.<you>.workers.dev",
  "mobileAppUrl": "https://priority-assistant.pages.dev/",
  "extensionKey": "<written by npm run keygen>",
  "geminiModel": "gemini-flash-latest",
  "geminiFastModel": "gemini-flash-lite-latest"
}
```

Run `npm run build`, reload the extension, and redeploy the phone app (step 8). The extension's settings page has a **Setup check** that shows what's still missing.

## 10. First run with a real account

1. In the extension settings, click **Connect Gmail** or **Connect Outlook**.
2. The assistant reads the last 60 days (who you answer and how fast, what you forward and to whom, what lives in each of your folders) and tests itself on the newest 30%. If its guesses already match 85% of what you did, suggestions turn on right away. Otherwise it stays in **Learning mode** and watches until it gets there.
3. On your phone, open the hosted app, sign in with the same account and **Add to Home Screen**. Both devices share what was learned through a hidden file in your own Google Drive / OneDrive app folder.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Priority Assistant was updated. Reload this page" | Reload the Gmail/Outlook tab after reloading the extension. |
| Sign-in window says redirect_uri_mismatch | The redirect URL printed by `npm run keygen` must be in the Google/Microsoft redirect list exactly, trailing slash included. |
| Outlook sign-in: AADSTS9002327 or "Cross-origin token redemption" | The redirect URIs were added under "Single-page application". Move them to **Web**. |
| AI says "not on the tester list" | Add the email to `ALLOWED_EMAILS` and `npx wrangler deploy` again, or paste a personal Gemini key in Settings. |
| AI model not found | Set `geminiModel` / `geminiFastModel` in config.json to a current model from https://ai.google.dev/gemini-api/docs/models and rebuild. |
| Gmail sign-in stops after a week | Expected in Testing mode. Click Connect Gmail again. |
