/* Page adapters: where the inbox list sits on screen, which account the page belongs to, and how to open an email
   natively. Kept small on purpose: the overlay draws its own list, so we depend on very little of Gmail's or
   Outlook's page structure. */
import type { RowVM } from '../core/service';

export interface Site {
  name: 'gmail' | 'outlook' | 'harness';
  label: string;
  isListRoute(): boolean;
  listRect(): DOMRect | null;
  panelInsets(): { top: number; right: number; bottom: number };
  accountHint(): string;
  openNative(row: RowVM, path: string | null): void;
  /** Navigate to the inbox (used when Priority view is turned on from another folder). */
  goToInbox(): void;
  /** Thread id of an email the user opened natively, when we can tell. */
  nativeThreadId(): string | null;
  /** The page element whose content the overlay replaces; hidden while the overlay is up. */
  hideSelector: string;
  /** The mail page's own left sidebar (folders, labels). Clicks left of the overlay count too. */
  sidebarSelector?: string;
  /** Sidebar buttons that open something on top of the overlay (Compose), so Priority view can stay on. */
  keepPriorityViewSelector?: string;
  /** The page's own popups (Compose windows, menus, dialogs), which must show above the overlay and panel. */
  popupSelector?: string;
  /** Page containers known to hold those popups, raised directly. */
  liftSelector?: string;
  /** True when the mail page is using a dark theme. */
  isDark(): boolean;
}

/** Dark if the first opaque background behind the given element (or the page) is dark. */
export function pageIsDark(selectors: string[]): boolean {
  let el: Element | null = selectors.map((s) => document.querySelector(s)).find(Boolean) || document.body;
  while (el) {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(el).backgroundColor);
    if (m && (m[4] === undefined || Number(m[4]) > 0.5)) {
      const [r, g, b] = [m[1], m[2], m[3]].map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
    }
    el = el.parentElement;
  }
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

function rectOf(selectors: string[]): DOMRect | null {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 240 && rect.height > 200) return rect;
  }
  return null;
}

export const gmail: Site = {
  name: 'gmail',
  label: 'Gmail',
  isListRoute: () => /^#?(inbox)?(\/p\d+)?(\?.*)?$/i.test(location.hash),
  listRect: () => rectOf(['div[role="main"]']),
  panelInsets: () => ({ top: 72, right: 70, bottom: 16 }),
  accountHint() {
    const fromTitle = EMAIL_RE.exec(document.title)?.[0];
    if (fromTitle) return fromTitle.toLowerCase();
    const button = document.querySelector('a[aria-label*="@"]');
    return (EMAIL_RE.exec(button?.getAttribute('aria-label') || '')?.[0] || '').toLowerCase();
  },
  openNative(row) { location.hash = `#inbox/${row.threadId}`; },
  goToInbox() { location.hash = '#inbox'; },
  nativeThreadId() {
    if (!/^#[^/]+\/.{12,}/.test(location.hash)) return null;
    return document.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id') || null;
  },
  hideSelector: 'div[role="main"]',
  sidebarSelector: '.aeN, div[role="navigation"]', // .aeN is the left column
  keepPriorityViewSelector: '.aic, [gh="cm"]', // the Compose button
  liftSelector: '.dw', // Gmail's Compose dock: every Compose window lives in it (absolute, z-index 3, child of <body>)
  // name="subjectbox" and g_editable are inside every Compose window (docked or full screen)
  popupSelector: 'input[name="subjectbox"], div[g_editable="true"], div[role="dialog"], div[role="alertdialog"], div[role="menu"]',
  isDark: () => pageIsDark(['div[role="main"]']),
};

export const outlook: Site = {
  name: 'outlook',
  label: 'Outlook',
  isListRoute: () => /^\/mail(\/0)?\/?(inbox\/?)?$/i.test(location.pathname),
  listRect: () => rectOf(['#MainModule', 'div[role="main"]', '#app main']),
  panelInsets: () => ({ top: 60, right: 14, bottom: 14 }),
  accountHint() {
    const candidates = [
      document.querySelector('#mectrl_currentAccount_secondary')?.textContent,
      document.querySelector('#O365_MainLink_Me')?.getAttribute('aria-label'),
      document.querySelector('button[aria-label*="@"]')?.getAttribute('aria-label'),
      document.title,
    ];
    for (const text of candidates) { const m = EMAIL_RE.exec(text || ''); if (m) return m[0].toLowerCase(); }
    return '';
  },
  openNative(row, path) {
    if (path) location.href = `${location.origin}${path}`;
    else if (row.webLink) window.open(row.webLink, '_blank', 'noopener');
  },
  nativeThreadId: () => null,
  goToInbox() { location.assign(`${location.origin}/mail/inbox`); },
  hideSelector: '#MainModule, div[role="main"]',
  popupSelector: 'div[role="dialog"], div[role="alertdialog"], div[role="menu"], .ms-Layer',
  isDark: () => pageIsDark(['#MainModule', 'div[role="main"]']),
};

export function detectSite(): Site | null {
  if (location.hostname === 'mail.google.com') return gmail;
  if (/^outlook\.(office|office365|live)\.com$|^outlook\.cloud\.microsoft$/.test(location.hostname)) return outlook;
  return null;
}
