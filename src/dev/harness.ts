/* Desktop demo: the real extension UI on a stand-in mail page, running against the demo mailbox. */
import { PaApp } from '../extension/ui/app';
import type { Site } from '../extension/sites';
import { LocalBackend } from '../core/local-backend';
import { LocalStorageKV } from '../core/state';
import { openService, demoAccount } from '../core/accounts';

const site: Site = {
  name: 'harness',
  label: 'Gmail',
  isListRoute: () => !location.hash || location.hash === '#inbox',
  listRect: () => document.querySelector('[role=main]')!.getBoundingClientRect(),
  panelInsets: () => ({ top: 72, right: 70, bottom: 16 }),
  accountHint: () => '',
  openNative: (row) => alert(`In Gmail this opens the thread natively (#inbox/${row.threadId}).`),
  goToInbox: () => { location.hash = '#inbox'; },
  nativeThreadId: () => null,
  hideSelector: '[role=main]',
  sidebarSelector: '.side',
  keepPriorityViewSelector: '.compose',
  popupSelector: 'input[name="subjectbox"], div[role="dialog"]',
  isDark: () => document.body.classList.contains('dark') || matchMedia('(prefers-color-scheme: dark)').matches,
};

if (new URLSearchParams(location.search).has('dark')) document.body.classList.add('dark');

// A stand-in for Gmail's Compose window: docked bottom right in a fixed container with a low z-index, like Gmail's.
document.querySelector('.compose')!.addEventListener('click', () => {
  let dock = document.querySelector<HTMLElement>('.dw');
  if (!dock) {
    dock = document.createElement('div');
    dock.className = 'dw';
    dock.style.cssText = 'position:fixed;right:72px;bottom:0;z-index:3;display:flex;gap:12px;align-items:flex-end';
    document.body.append(dock);
  }
  const win = document.createElement('div');
  win.setAttribute('role', 'dialog');
  win.className = 'compose-win';
  win.style.cssText = 'width:500px;height:440px;background:#fff;border-radius:12px 12px 0 0;box-shadow:0 8px 30px rgba(0,0,0,.3);display:flex;flex-direction:column;font:14px system-ui;color:#222';
  win.innerHTML = '<div style="background:#f2f6fc;padding:10px 14px;border-radius:12px 12px 0 0;display:flex"><b style="flex:1">New Message</b><button class="close-compose">✕</button></div><input placeholder="To" style="margin:8px 14px;border:0;border-bottom:1px solid #ddd;padding:6px 0"><input name="subjectbox" placeholder="Subject" style="margin:0 14px;border:0;border-bottom:1px solid #ddd;padding:6px 0"><div contenteditable="true" style="flex:1;padding:10px 14px">Demo compose window</div>';
  win.querySelector('.close-compose')!.addEventListener('click', () => win.remove());
  dock.append(win);
});

const kv = new LocalStorageKV('pa-demo:');
const backend = new LocalBackend(null, {
  settings: () => alert('In the extension this opens the settings page.'),
  connect: () => alert('In the extension this opens Google/Microsoft sign-in.'),
});
const host = document.createElement('div');
document.body.append(host);
const app = new PaApp(site, backend, host);
void app.start();
openService(demoAccount(), { kv, saveTokens: async () => undefined }).then(({ service }) => {
  backend.attach(service);
  (window as unknown as { pa: unknown }).pa = service;
}).catch((error) => { console.error(error); alert(`Demo failed to start: ${(error as Error).message}`); });
