/* Build-time configuration, injected by scripts/build.mjs from config.json. */
export interface AppConfig {
  googleClientId: string;
  microsoftClientId: string;
  proxyUrl: string;
  mobileAppUrl: string;
  extensionKey: string;
  extensionId: string;
  geminiModel: string;
  geminiFastModel: string;
  /** When this copy was built (set by scripts/build.mjs), to tell which version a tester is running. */
  build?: string;
}

declare const __CONFIG__: AppConfig;

export const CONFIG: AppConfig = typeof __CONFIG__ !== 'undefined' ? __CONFIG__ : {
  googleClientId: '', microsoftClientId: '', proxyUrl: '', mobileAppUrl: '', extensionKey: '', extensionId: '',
  geminiModel: 'gemini-flash-latest', geminiFastModel: 'gemini-flash-lite-latest',
};

export const GOOGLE_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.modify',     // read, label, move, send (no permanent delete)
  'https://www.googleapis.com/auth/drive.appdata',    // hidden app folder for the learned model
];

export const MICROSOFT_SCOPES = [
  'openid', 'email', 'profile', 'offline_access', 'User.Read',
  'Mail.ReadWrite', 'Mail.Send', 'MailboxSettings.ReadWrite', 'Files.ReadWrite.AppFolder',
];

export const proxyConfigured = () => Boolean(CONFIG.proxyUrl);
