/* Demo mailbox: Jeff Larsen, Project Executive at Prairie State Builders (the MVP's sample data), plus 60 days
   of generated history so the learning engine has real patterns to find. Lets anyone try the full app without
   connecting an account. Mailbox changes persist in the given KV store. */
import type { AccountInfo, Folder, FullMessage, MailBody, MailMessage, Person, PullResult, SentMessage, Tier } from '../types';
import type { KV } from '../state';
import { isForwardSubject, type MailProvider } from './provider';

const ME: Person = { name: 'Jeff Larsen', email: 'jeff@prairiestate.example' };
export const DEMO_ACCOUNT: AccountInfo = { kind: 'demo', email: ME.email, name: ME.name };
const P = (name: string, email: string): Person => ({ name, email });

export const DEMO_PEOPLE = {
  thomas: P('Thomas Keller', 'tkeller@prairiestate.example'),
  dave: P('Dave Kowalski', 'dkowalski@prairiestate.example'),
  aisha: P('Aisha Rahman', 'arahman@prairiestate.example'),
  priya: P('Priya Nair', 'pnair@prairiestate.example'),
};

const FOLDERS = ['Haymarket Lofts', 'Westbrook Clinic', 'Bids', 'Suppliers', 'Change orders', 'Procore', 'Newsletters'];

interface Seed { id: string; from: Person; subject: string; body: string; min: number; read?: boolean; cc?: boolean; attach?: boolean; bulk?: boolean; to?: Person[]; thread?: string }

const corey = P('Corey Hanlon', 'corey@hanlonlumber.example');
const rich = P('Rich Albrecht', 'rich@albrechtmech.example');
const mark = P('Mark Dvorak', 'mdvorak@lincoln.example');
const marcus = P('Marcus Webb', 'mwebb@prairiestate.example');
const dana = P('Dana Ortiz', 'dortiz@prairiestate.example');
const linda = P('Linda Chu', 'lchu@haymarketowners.example');
const john = P('John Meyer', 'jmeyer@prairiestate.example');
const procore = P('Procore', 'notifications@procore.example');
const sam = P('Sam Patel', 'sam@frontierhvac.example');
const tech = P('Luis Romero', 'lromero@prairiestate.example');

const DAY = 1440;
const SEEDS: Seed[] = [
  { id: 'e1', from: corey, min: 33, subject: 'Need materials', body: "Jeff,\n\nFraming package for Haymarket level 4 is short 40 studs and the 3/4\" plywood hasn't shipped yet. I can get a truck out Wednesday at 6 AM if you OK PO 7714 by noon today. Otherwise it slips to Friday.\n\nCall me if you want to talk it through: 402-555-0143.\n\nCorey" },
  { id: 'e2', from: rich, min: 65, attach: true, subject: 'Revised bid: Haymarket rooftop HVAC', body: "Jeff,\n\nAttached is our revised rooftop HVAC bid for Haymarket Lofts. We re-priced the units after talking to the manufacturer: $412,800, down from $438,500. Includes startup and a 2-year labor warranty. Roof curb alternate is not included.\n\nI'd like an answer by Friday so I can hold the equipment slot.\n\nRich" },
  { id: 'e3', from: mark, min: 80, subject: 'Inspection moved up to Wednesday', body: 'Good morning Jeff,\n\nWe had a cancellation, so your framing inspection for Haymarket Lofts (level 3) is moved up from Thursday to Wednesday at 9:00 AM. Please make sure the stair tower is accessible and the permit set is on site.\n\nReply to confirm.\n\nMark Dvorak\nBuilding Inspector' },
  { id: 'e4', from: marcus, min: 104, attach: true, subject: 'Change order for unit 4B', body: "Jeff,\n\nThe owner wants to upgrade the 4B kitchen cabinetry. I put together CO #12: +$18,240 and 6 working days. It needs a pricing review before we send it back to the owner.\n\nOnce you or Thomas sign off I'll send it today.\n\nMarcus" },
  { id: 'e5', from: dana, min: 123, subject: 'Pour schedule moved to Friday', body: 'Jeff,\n\nRain is forecast Thursday, so Capital Concrete moved the level 3 deck pour to Friday at 6 AM. That pushes two trades back a day but keeps us ahead of the inspection hold.\n\nNeed your OK on up to 8 hours of overtime for the finishers.\n\nDana' },
  { id: 'e6', from: marcus, min: 147, attach: true, subject: 'Blueprint question', body: 'Jeff,\n\nSheet A-402 shows the stair tower wall at 8" CMU but S-201 calls for 10". The framers are ready to start. Which one governs?\n\nI marked up both sheets and attached them.\n\nMarcus' },
  { id: 'e7', from: linda, min: 175, read: true, subject: 'Question about the change order', body: 'Jeff,\n\nCan you explain the $6,900 line for lobby lighting in CO #11? Our electrician thinks it should be less. Happy to talk this week.\n\nLinda' },
  { id: 'e8', from: john, min: 193, read: true, attach: true, subject: 'Crew schedule for next week', body: 'Jeff,\n\nCrew schedule for next week is attached. Two framers are out Tuesday, so I moved a laborer over to help.\n\nJohn' },
  { id: 'e9', from: P('Prairie Equipment Rental', 'quotes@prairieequip.example'), min: 215, subject: 'Quote: 80 ft boom lift, 4 weeks', body: 'Hi Jeff,\n\nHere is the quote you asked for: 80 ft boom lift, 4 weeks, delivery and pickup included, $9,850. Quote is good for 7 days.\n\nPrairie Equipment Rental' },
  { id: 'e10', from: P('Capital Lumber Dispatch', 'dispatch@capitallumber.example'), min: 240, subject: 'Lumber delivery window', body: 'Jeff, your Tuesday delivery window is 10 AM to 2 PM. Please confirm someone can receive and unload.\n\nCapital Lumber Dispatch' },
  { id: 'e11', from: P('Ben Torres', 'btorres@prairiestate.example'), min: 257, read: true, attach: true, subject: 'Final safety inputs for Westbrook', body: 'Jeff, final safety inputs for the Westbrook site plan are attached. I need a sign-off from the superintendent before we submit.\n\nBen' },
  { id: 'e12', from: procore, min: 285, bulk: true, subject: 'RFI #214 response posted', body: 'A response was posted to RFI #214 (Stair tower wall type) on Haymarket Lofts.\n\nView in Procore.' },
  { id: 'e13', from: procore, min: 313, bulk: true, subject: 'Daily log submitted: Haymarket Lofts', body: 'Priya Nair submitted the daily log for Haymarket Lofts (Sunday).\n\nView in Procore.' },
  { id: 'e14', from: procore, min: 330, bulk: true, subject: 'Submittal 05 12 00 Structural Steel: status changed', body: 'The status of submittal 05 12 00 was changed to "Revise and Resubmit".\n\nView in Procore.' },
  { id: 'e15', from: procore, min: 365, bulk: true, subject: 'You were assigned a punch list item', body: 'Punch list item #88 (Level 2 corridor paint touch-up) was assigned to you.\n\nView in Procore.' },
  { id: 'e16', from: P('ENR Midwest', 'news@enr.example'), min: 425, read: true, bulk: true, subject: 'This week in construction', body: 'Steel prices ease again, labor shortages continue, and 5 projects to watch in the Midwest.' },
  { id: 'e17', from: P('AGC of Nebraska', 'weekly@agcne.example'), min: 470, read: true, bulk: true, subject: 'AGC Nebraska weekly update', body: 'Upcoming safety trainings, legislative update, and member news.' },
  { id: 'e19', from: P('Hanlon Lumber & Supply', 'billing@hanlonlumber.example'), min: DAY + 60, read: true, attach: true, subject: 'Invoice #44871 ($12,406.18)', body: 'Invoice #44871 for framing lumber, Haymarket level 3. Terms: net 30.' },
  { id: 'e20', from: P('Capital Concrete', 'ar@capitalconcrete.example'), min: DAY + 90, read: true, attach: true, subject: 'Invoice 2291: level 2 deck pour', body: 'Invoice 2291 for the level 2 deck pour: $31,880.00. Terms: net 30.' },
  { id: 'e22', from: DEMO_PEOPLE.priya, min: DAY + 150, read: true, cc: true, attach: true, subject: 'FYI: toolbox talk notes', body: 'Notes from Monday toolbox talk (fall protection) attached. CC to all PMs.' },
  { id: 'e23', from: marcus, min: DAY + 180, read: true, cc: true, subject: 'RE: RE: Crew lunch Friday', body: 'Works for me. Pizza or BBQ? (replying all, sorry)' },
  { id: 'e24', from: dana, min: DAY + 210, read: true, cc: true, attach: true, subject: 'Daily report: Westbrook Clinic', body: 'Daily report attached. No incidents. Weather: clear, 54F.' },
  { id: 'e26', from: P('HR Benefits', 'hr@prairiestate.example'), min: DAY + 300, read: true, bulk: true, subject: 'Open enrollment ends Friday', body: 'Reminder: open enrollment closes this Friday.' },
  { id: 'e34', from: P('LinkedIn', 'notify@linkedin.example'), min: 5 * DAY, read: true, bulk: true, subject: 'Jeff, you appeared in 9 searches', body: 'See who is looking at your profile.' },
  // Rick's case: a long vendor/technician thread Jeff is copied on.
  { id: 'r1', thread: 'tr', from: tech, min: 9 * 60, cc: true, to: [sam], subject: 'Westbrook RTU-2 not cooling', body: 'Sam, RTU-2 at Westbrook is blowing warm air since 6 AM. Compressor hums but will not start. Can you send someone today?\n\nLuis' },
  { id: 'r2', thread: 'tr', from: sam, min: 8 * 60 + 40, cc: true, to: [tech], read: true, subject: 'RE: Westbrook RTU-2 not cooling', body: 'Luis, sending Mike. ETA 10:30. Can you make sure the roof hatch is unlocked?\n\nSam' },
  { id: 'r3', thread: 'tr', from: tech, min: 7 * 60, cc: true, to: [sam], read: true, subject: 'RE: Westbrook RTU-2 not cooling', body: 'Hatch is open. Mike is up there now.' },
  { id: 'r4', thread: 'tr', from: sam, min: 5 * 60 + 15, cc: true, to: [tech], read: true, subject: 'RE: Westbrook RTU-2 not cooling', body: 'Mike found a failed start capacitor and low refrigerant. He replaced the capacitor. Refrigerant leak check needs a second visit tomorrow morning. Unit is running at about 70% for now.' },
  { id: 'r5', thread: 'tr', from: tech, min: 3 * 60 + 30, cc: true, to: [sam], subject: 'RE: Westbrook RTU-2 not cooling', body: 'Thanks. Clinic says exam rooms 4-6 are still warm. Can Mike bring a portable unit for tonight?' },
  { id: 'r6', thread: 'tr', from: sam, min: 95, cc: true, to: [tech], subject: 'RE: Westbrook RTU-2 not cooling', body: 'Portable unit dropped at 1 PM. Leak check is booked for 7 AM tomorrow. Estimate for the refrigerant work is $1,450; needs Jeff\'s approval before we charge the system.' },
];

/** Deterministic pseudo-random numbers so the demo history is the same on every device. */
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }

interface Profile { from: Person[]; subjects: string[]; n: number; outcome: 'reply-fast' | 'reply' | 'forward' | 'file' | 'trash' | 'ignore' | 'read'; folder?: string; to?: Person; cc?: boolean; bulk?: boolean; attach?: boolean }

const PROFILES: Profile[] = [
  { from: [corey], subjects: ['Delivery tomorrow?', 'PO question for level 2', 'Short on sheathing', 'Truck running late', 'Need a yes on the lumber order'], n: 9, outcome: 'reply-fast' },
  { from: [rich], subjects: ['Bid clarification', 'Equipment lead times', 'Startup schedule', 'Revised scope for Westbrook'], n: 6, outcome: 'reply' },
  { from: [mark], subjects: ['Inspection scheduled', 'Permit comments', 'Re-inspection needed'], n: 4, outcome: 'reply-fast' },
  { from: [marcus], subjects: ['Change order for unit 2A', 'Change order: lobby finishes', 'CO pricing needed', 'Change order request'], n: 6, outcome: 'forward', to: DEMO_PEOPLE.thomas, folder: 'Change orders', attach: true },
  { from: [marcus, dana], subjects: ['Schedule question', 'Need your OK on overtime', 'Crane booking', 'Site access tomorrow', 'Weather delay'], n: 10, outcome: 'reply' },
  { from: [dana, john, P('Ben Torres', 'btorres@prairiestate.example')], subjects: ['Daily report: Haymarket Lofts', 'Daily report: Westbrook Clinic', 'Weekly manpower'], n: 14, outcome: 'read', cc: true, attach: true },
  { from: [procore], subjects: ['Daily log submitted', 'RFI response posted', 'Submittal status changed', 'Punch list item assigned', 'Weekly digest'], n: 34, outcome: 'file', folder: 'Procore', bulk: true },
  { from: [procore], subjects: ['Observation created', 'Meeting minutes posted'], n: 8, outcome: 'ignore', bulk: true },
  { from: [P('ENR Midwest', 'news@enr.example'), P('AGC of Nebraska', 'weekly@agcne.example'), P('Lincoln Business Daily', 'briefing@lbd.example')], subjects: ['This week in construction', 'Weekly update', 'Morning briefing'], n: 20, outcome: 'file', folder: 'Newsletters', bulk: true },
  { from: [P('LinkedIn', 'notify@linkedin.example'), P('Equipment World', 'promo@equipmentworld.example')], subjects: ['You appeared in searches', 'New deals on attachments', 'People you may know'], n: 12, outcome: 'trash', bulk: true },
  { from: [P('Hanlon Lumber & Supply', 'billing@hanlonlumber.example'), P('Capital Concrete', 'ar@capitalconcrete.example'), P('Midwest Rebar', 'accounts@midwestrebar.example')], subjects: ['Invoice #44102', 'Invoice 2214', 'Account statement', 'Invoice #44590'], n: 10, outcome: 'forward', to: DEMO_PEOPLE.aisha, folder: 'Suppliers', attach: true },
  { from: [P('Kelsey Park', 'kpark@parkarch.example')], subjects: ['ASI issued', 'Revised drawings: Haymarket', 'Architect response to RFI'], n: 8, outcome: 'file', folder: 'Haymarket Lofts', attach: true },
  { from: [P('Lincoln Electric System', 'engineering@les.example'), john], subjects: ['Westbrook service upgrade', 'Westbrook site meeting notes', 'Westbrook utility schedule'], n: 7, outcome: 'file', folder: 'Westbrook Clinic' },
  { from: [P('Prairie Sheet Metal', 'shop@psm.example'), P('Frontier HVAC', 'bids@frontierhvac.example')], subjects: ['Bid: ductwork package', 'Bid due Friday', 'Updated bid form'], n: 7, outcome: 'file', folder: 'Bids', attach: true },
];

interface Store {
  inbox: Record<string, { inInbox: boolean; inTrash: boolean; isRead: boolean; flagged: boolean; folderId: string | null; tier: Tier | null; v: number }>;
  sent: Array<SentMessage & { v: number }>;
  arrivals: Array<{ message: MailMessage; body: string }>;
  folders: string[];
  version: number;
  sync: string | null;
}

export class DemoProvider implements MailProvider {
  readonly kind = 'demo' as const;
  private base: Map<string, MailMessage> = new Map();
  private bodies = new Map<string, string>();
  private hist: MailMessage[] = [];
  private histSent: SentMessage[] = [];
  private store: Store = { inbox: {}, sent: [], arrivals: [], folders: [...FOLDERS, 'CC'], version: 1, sync: null };
  private ready: Promise<void>;
  private anchor = Date.now();

  constructor(private kv: KV) {
    this.ready = this.load();
  }

  private async load() {
    const saved = await this.kv.get<Store & { anchor: number }>('demo-mailbox');
    if (saved?.anchor) { this.anchor = saved.anchor; this.store = { ...this.store, ...saved, arrivals: saved.arrivals || [] }; }
    this.build();
  }

  private save() { void this.kv.set('demo-mailbox', { ...this.store, anchor: this.anchor }); }

  private folderId = (name: string) => `f:${name}`;

  private build() {
    const at = (min: number) => this.anchor - min * 60000;
    for (const s of SEEDS) {
      const recipients = s.to || [ME];
      const message: MailMessage = {
        id: s.id, threadId: s.thread || `t_${s.id}`, from: s.from,
        to: s.cc ? recipients.filter((p) => p.email !== ME.email).concat(s.to ? [] : [DEMO_PEOPLE.dave]) : recipients,
        cc: s.cc ? [ME, DEMO_PEOPLE.priya] : [],
        subject: s.subject, snippet: s.body.replace(/^(Jeff|Hi Jeff|Good morning Jeff),?\s*/i, '').replace(/\s+/g, ' ').slice(0, 160),
        date: at(s.min), isRead: Boolean(s.read), flagged: false, hasAttachments: Boolean(s.attach), inInbox: true, inTrash: false,
        folderId: null, isBulk: Boolean(s.bulk), importance: 'normal',
      };
      this.base.set(s.id, message);
      this.bodies.set(s.id, s.body);
      if (!this.store.inbox[s.id]) this.store.inbox[s.id] = { inInbox: true, inTrash: false, isRead: message.isRead, flagged: false, folderId: null, tier: null, v: 1 };
    }
    for (const { message, body } of this.store.arrivals) { this.base.set(message.id, message); this.bodies.set(message.id, body); }
    // 60 days of history with clear habits for the learning engine to discover.
    const rand = rng(42);
    let n = 0;
    for (const profile of PROFILES) {
      for (let i = 0; i < profile.n; i++) {
        const from = profile.from[i % profile.from.length];
        const subject = profile.subjects[i % profile.subjects.length];
        const date = this.anchor - (2 + rand() * 58) * DAY * 60000;
        const id = `h${n++}`;
        const outcome = profile.outcome;
        const m: MailMessage = {
          id, threadId: `th_${id}`, from, to: profile.cc ? [DEMO_PEOPLE.dave] : [ME], cc: profile.cc ? [ME] : [],
          subject, snippet: `${subject}. ${from.name.split(' ')[0]} sent this ${outcome === 'forward' ? 'for review' : 'for your info'}.`,
          date, isRead: outcome !== 'ignore' && outcome !== 'trash' ? true : rand() > 0.7, flagged: false, hasAttachments: Boolean(profile.attach),
          inInbox: outcome === 'reply' || outcome === 'reply-fast' || outcome === 'read' || outcome === 'ignore',
          inTrash: outcome === 'trash', folderId: profile.folder && (outcome === 'file' || outcome === 'forward') ? this.folderId(profile.folder) : null,
          isBulk: Boolean(profile.bulk), importance: 'normal',
        };
        this.hist.push(m);
        if (outcome === 'reply' || outcome === 'reply-fast') {
          const latency = outcome === 'reply-fast' ? 10 + rand() * 50 : 90 + rand() * 600;
          this.histSent.push({ id: `s_${id}`, threadId: m.threadId, to: [from], subject: `Re: ${subject}`, date: date + latency * 60000, kind: 'reply' });
        }
        if (outcome === 'forward' && profile.to) {
          this.histSent.push({ id: `s_${id}`, threadId: m.threadId, to: [profile.to], subject: `Fwd: ${subject}`, date: date + (20 + rand() * 200) * 60000, kind: 'forward' });
        }
      }
    }
  }

  private current(id: string): MailMessage | null {
    const base = this.base.get(id);
    const s = this.store.inbox[id];
    if (!base || !s) return null;
    return { ...base, inInbox: s.inInbox, inTrash: s.inTrash, isRead: s.isRead, flagged: s.flagged, folderId: s.folderId };
  }

  async account(): Promise<AccountInfo> { return DEMO_ACCOUNT; }

  async pull(cursor: string | null): Promise<PullResult> {
    await this.ready;
    const since = cursor ? Number(cursor) || 0 : 0;
    const upserts = Object.entries(this.store.inbox).filter(([, st]) => st.v > since).map(([id]) => this.current(id)).filter((m): m is MailMessage => Boolean(m));
    const sent = cursor ? this.store.sent.filter((m) => m.v > since).map(({ v, ...m }) => { void v; return m; }) : [];
    return { cursor: String(this.store.version), upserts, removedIds: [], sent, full: !cursor };
  }

  async history(): Promise<MailMessage[]> { await this.ready; return this.hist; }
  async sentHistory(): Promise<SentMessage[]> { await this.ready; return this.histSent; }
  async folders(): Promise<Folder[]> { return this.store.folders.map((name) => ({ id: this.folderId(name), name })); }
  async folderMessages(folderId: string): Promise<MailMessage[]> { await this.ready; return this.hist.filter((m) => m.folderId === folderId); }

  async body(message: MailMessage): Promise<MailBody> {
    await this.ready;
    return { text: this.bodies.get(message.id) || `${message.subject}\n\n${message.snippet}`, attachments: message.hasAttachments ? [{ name: `${message.subject.slice(0, 24)}.pdf`, size: 240000 }] : [] };
  }

  async thread(threadId: string): Promise<FullMessage[]> {
    await this.ready;
    const ids = [...this.base.values()].filter((m) => m.threadId === threadId).map((m) => m.id);
    return Promise.all(ids.map(async (id) => ({ ...this.current(id)!, body: await this.body(this.current(id)!) })));
  }

  private touch(id: string, patch: Partial<Store['inbox'][string]>) {
    this.store.version += 1;
    this.store.inbox[id] = { ...this.store.inbox[id], ...patch, v: this.store.version };
    this.save();
  }

  private record(m: SentMessage) { this.store.version += 1; this.store.sent.push({ ...m, v: this.store.version }); this.save(); }

  async reply(message: MailMessage, text: string): Promise<void> {
    this.record({ id: `sent_${Date.now()}`, threadId: message.threadId, to: [message.from], subject: `Re: ${message.subject}`, date: Date.now(), kind: 'reply' });
    void text;
  }

  async forward(message: MailMessage, to: Person[]): Promise<void> {
    this.record({ id: `sent_${Date.now()}`, threadId: message.threadId, to, subject: isForwardSubject(message.subject) ? message.subject : `Fwd: ${message.subject}`, date: Date.now(), kind: 'forward' });
  }

  async moveToFolder(message: MailMessage, folderId: string) { this.touch(message.id, { inInbox: false, folderId, inTrash: false }); }
  async moveToInbox(message: MailMessage) { this.touch(message.id, { inInbox: true, inTrash: false, folderId: null }); }
  async trash(message: MailMessage) { this.touch(message.id, { inInbox: false, inTrash: true }); }
  async archive(message: MailMessage) { this.touch(message.id, { inInbox: false }); }
  async markRead(message: MailMessage, read: boolean) { this.touch(message.id, { isRead: read }); }
  async setFlag(message: MailMessage, flagged: boolean) { this.touch(message.id, { flagged }); }
  async ensureFolder(name: string): Promise<Folder> {
    if (!this.store.folders.includes(name)) { this.store.folders.push(name); this.save(); }
    return { id: this.folderId(name), name };
  }
  async setTier(message: MailMessage, tier: Tier | null) { if (this.store.inbox[message.id]) { this.store.inbox[message.id].tier = tier; this.save(); } }

  async loadSyncDoc(): Promise<string | null> { await this.ready; return this.store.sync; }
  async saveSyncDoc(json: string): Promise<void> { this.store.sync = json; this.save(); }

  /** Demo-only: drop a new email into the inbox (to watch live learning and auto-filing). */
  async simulateArrival(): Promise<void> {
    await this.ready;
    const id = `n${Date.now()}`;
    const options: Array<[Person, string, string, boolean]> = [
      [corey, 'Can you approve the sheathing order?', 'Jeff, need a yes on the sheathing order for level 5 by 2 PM or it misses tomorrow\'s truck.', false],
      [procore, 'RFI #219 response posted', 'A response was posted to RFI #219 on Haymarket Lofts. View in Procore.', true],
      [P('Midwest Rebar', 'accounts@midwestrebar.example'), 'Invoice #9921', 'Invoice #9921 for rebar delivered to Westbrook. Terms: net 30.', false],
    ];
    const [from, subject, body, bulk] = options[Math.floor(Math.random() * options.length)];
    const message: MailMessage = { id, threadId: `t_${id}`, from, to: [ME], cc: [], subject, snippet: body.slice(0, 160), date: Date.now(), isRead: false, flagged: false, hasAttachments: false, inInbox: true, inTrash: false, folderId: null, isBulk: bulk, importance: 'normal' };
    this.store.arrivals.push({ message, body });
    this.base.set(id, message);
    this.bodies.set(id, body);
    this.touch(id, { inInbox: true, inTrash: false, isRead: false, flagged: false, folderId: null, tier: null });
  }
}
