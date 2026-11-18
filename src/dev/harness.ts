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
  nativeThreadId: () => null,
  hideSelector: '[role=main]',
  sidebarSelector: '.side',
  isDark: () => document.body.classList.contains('dark') || matchMedia('(prefers-color-scheme: dark)').matches,
};

if (new URLSearchParams(location.search).has('dark')) document.body.classList.add('dark');

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
