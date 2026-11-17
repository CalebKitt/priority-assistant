/* The three small models that run on the user's device:
   - PriorityModel: logistic regression, "will you act on this soon?"
   - FolderModel: naive Bayes over your existing folders, "where would you file this?"
   - ForwardModel: counts, "who do you forward emails like this to?"
   All are retrained from the decision log in milliseconds, so there are no weights to merge between devices. */
import type { Decision, DecisionKind } from '../types';
import { folderFeatures } from './features';

export const POSITIVE: DecisionKind[] = ['replied', 'forwarded', 'flagged', 'made-priority'];
export const NEGATIVE: DecisionKind[] = ['trashed', 'ignored', 'archived', 'not-priority', 'later', 'read-only', 'filed'];

export interface Example { features: string[]; y: 0 | 1; weight: number; msgId: string; at: number }

function weightOf(d: Decision): number {
  switch (d.kind) {
    case 'replied': {
      const l = d.latencyMin ?? 600;
      return l <= 60 ? 1.6 : l <= 240 ? 1.3 : l <= 1440 ? 1 : 0.7;
    }
    case 'forwarded': return 1.2;
    case 'flagged': return 1;
    case 'made-priority': return 2;
    case 'not-priority': return 2;
    case 'later': return 1.5;
    case 'trashed': return d.wasRead ? 0.8 : 1.2;
    case 'ignored': return 1;
    case 'archived': return d.wasRead ? 0.4 : 0.8;
    case 'read-only': return 0.5;
    case 'filed': return 0.5;
    default: return 0;
  }
}

/** One labelled example per email: any positive action wins; explicit corrections beat observed behavior. */
export function examplesFrom(decisions: Decision[]): Example[] {
  const byMsg = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (!POSITIVE.includes(d.kind) && !NEGATIVE.includes(d.kind)) continue;
    if (!d.features?.length) continue;
    (byMsg.get(d.msgId) || byMsg.set(d.msgId, []).get(d.msgId)!).push(d);
  }
  const out: Example[] = [];
  for (const [msgId, list] of byMsg) {
    const explicit = list.filter((d) => d.kind === 'made-priority' || d.kind === 'not-priority' || d.kind === 'later').sort((a, b) => b.at - a.at)[0];
    const chosen = explicit || list.filter((d) => POSITIVE.includes(d.kind)).sort((a, b) => weightOf(b) - weightOf(a))[0]
      || list.sort((a, b) => weightOf(b) - weightOf(a))[0];
    out.push({ features: chosen.features, y: POSITIVE.includes(chosen.kind) ? 1 : 0, weight: weightOf(chosen), msgId, at: chosen.at });
  }
  return out;
}

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export class PriorityModel {
  w = new Map<string, number>();
  trainedOn = 0;

  score(features: string[]): number {
    let z = 0;
    for (const f of features) z += this.w.get(f) || 0;
    return sigmoid(z);
  }

  /** Features pushing this email up the most (for explanations). */
  contributions(features: string[]): Array<[string, number]> {
    return features.filter((f) => f !== 'bias').map((f) => [f, this.w.get(f) || 0] as [string, number]).sort((a, b) => b[1] - a[1]);
  }

  /** Full retrain by SGD with L2. Deterministic shuffle so every device lands on the same weights. */
  train(examples: Example[], epochs = 12): void {
    this.w = new Map();
    this.trainedOn = examples.length;
    if (!examples.length) return;
    const positives = examples.filter((e) => e.y === 1).length;
    const prior = Math.min(0.9, Math.max(0.05, (positives + 1) / (examples.length + 2)));
    this.w.set('bias', Math.log(prior / (1 - prior)));
    const order = examples.map((_, i) => i);
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const l2 = 0.002;
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const lr = 0.35 / (1 + epoch * 0.25);
      for (const idx of order) {
        const ex = examples[idx];
        const g = (this.score(ex.features) - ex.y) * ex.weight;
        for (const f of ex.features) {
          const cur = this.w.get(f) || 0;
          this.w.set(f, cur - lr * (g + l2 * cur));
        }
      }
    }
  }
}

export interface FolderExample { features: string[]; folder: string }   // folder '' = stays in inbox

export class FolderModel {
  private counts = new Map<string, Map<string, number>>();
  private totals = new Map<string, number>();
  private docs = new Map<string, number>();
  private vocab = new Set<string>();
  private nDocs = 0;

  train(examples: FolderExample[]): void {
    this.counts.clear(); this.totals.clear(); this.docs.clear(); this.vocab.clear(); this.nDocs = 0;
    for (const ex of examples) {
      const feats = folderFeatures(ex.features);
      if (!feats.length) continue;
      const c = this.counts.get(ex.folder) || new Map<string, number>();
      for (const f of feats) { c.set(f, (c.get(f) || 0) + 1); this.vocab.add(f); }
      this.counts.set(ex.folder, c);
      this.totals.set(ex.folder, (this.totals.get(ex.folder) || 0) + feats.length);
      this.docs.set(ex.folder, (this.docs.get(ex.folder) || 0) + 1);
      this.nDocs += 1;
    }
  }

  get folders(): string[] { return [...this.docs.keys()].filter((f) => f); }

  /** Most likely destination ('' = leave in inbox) and its probability. */
  predict(features: string[]): { folder: string; p: number } {
    const feats = folderFeatures(features);
    if (!this.nDocs || !feats.length) return { folder: '', p: 0 };
    const V = this.vocab.size + 1;
    const logs: Array<[string, number]> = [];
    for (const [folder, n] of this.docs) {
      const c = this.counts.get(folder)!;
      const total = this.totals.get(folder)!;
      let lp = Math.log(n / this.nDocs);
      for (const f of feats) lp += Math.log(((c.get(f) || 0) + 0.5) / (total + 0.5 * V));
      logs.push([folder, lp]);
    }
    const max = Math.max(...logs.map(([, l]) => l));
    const sum = logs.reduce((s, [, l]) => s + Math.exp(l - max), 0);
    const [folder, best] = logs.sort((a, b) => b[1] - a[1])[0];
    return { folder, p: Math.exp(best - max) / sum };
  }
}

export class ForwardModel {
  private byFeature = new Map<string, Map<string, number>>();   // feature -> target -> forwards
  private totals = new Map<string, number>();                    // feature -> emails seen with it

  train(decisions: Decision[]): void {
    this.byFeature.clear(); this.totals.clear();
    const seen = new Set<string>();
    for (const d of decisions) {
      if (!d.features?.length) continue;
      if (!seen.has(d.msgId)) {
        seen.add(d.msgId);
        for (const f of folderFeatures(d.features)) this.totals.set(f, (this.totals.get(f) || 0) + 1);
      }
      if (d.kind !== 'forwarded' || !d.to) continue;
      for (const f of folderFeatures(d.features)) {
        const m = this.byFeature.get(f) || new Map<string, number>();
        m.set(d.to, (m.get(d.to) || 0) + 1);
        this.byFeature.set(f, m);
      }
    }
  }

  private n(f: string, to: string) { return this.byFeature.get(f)?.get(to) || 0; }
  private rate(f: string, to: string) { const t = this.totals.get(f) || 0; return t ? this.n(f, to) / t : 0; }

  /** Suggested forward target. Needs a sender you usually forward, or a topic you usually forward (invoices,
      change orders); a sender you normally answer yourself is never suggested just for sharing a domain. */
  predict(features: string[]): { to: string; count: number; via: string } | null {
    const feats = folderFeatures(features);
    const from = feats.find((f) => f.startsWith('from:'));
    const targets = new Set<string>();
    for (const f of feats) this.byFeature.get(f)?.forEach((_, to) => targets.add(to));
    let best: { to: string; score: number; count: number; via: string } | null = null;
    for (const to of targets) {
      const topic = feats.filter((f) => f.startsWith('w:') && this.n(f, to) >= 2 && this.rate(f, to) >= 0.5).sort((a, b) => this.n(b, to) - this.n(a, to))[0];
      const senderSeen = from ? this.totals.get(from) || 0 : 0;
      const senderRate = from ? this.rate(from, to) : 0;
      const dom = feats.find((f) => f.startsWith('dom:'));
      let via = '';
      if (from && senderSeen >= 2 && senderRate >= 0.8) via = from;
      else if (topic && (senderSeen < 2 || senderRate >= 0.3 || this.n(topic, to) >= 3)) via = topic;
      else if (senderSeen < 2 && dom && this.n(dom, to) >= 2 && this.rate(dom, to) >= 0.6) via = dom;
      if (!via) continue;
      const count = this.n(via, to);
      const score = count * (via.startsWith('from:') ? 3 : via.startsWith('w:') ? 2 : 1.5) + (from ? this.n(from, to) : 0);
      if (count >= 2 && (!best || score > best.score)) best = { to, score, count, via };
    }
    return best ? { to: best.to, count: best.count, via: best.via } : null;
  }
}
