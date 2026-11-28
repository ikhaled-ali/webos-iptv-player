// The phone's copy of the finder's settings: edited here, then sent to the
// TV with Send to TV, which answers with an ack in its next settings. Text
// from the relay is set only through textContent.
import {
  FREQUENCY_RANGE,
  SYMBOL_RATE_RANGE,
  type ApplyMessage,
  type SettingsMessage,
  type SharedOption,
  type SharedTransponder,
  type ViewerLabels,
} from '../services/finder-share-protocol';
import {
  applyMessage,
  draftFrom,
  editForm,
  isDirty,
  numberIn,
  pickSatellite,
  pickTransponder,
  rebase,
  satelliteIn,
  toneLocked,
  type Draft,
  type FormPatch,
} from './settings-draft';

// The TV answers within a second or two; past this the send is lost.
export const ANSWER_MS = 8000;

type SendPhase = 'sending' | 'applied' | 'notApplied' | 'noAnswer';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function tpLabel(tp: SharedTransponder): string {
  return [String(tp[1]), tp[2], tp[3] ? String(tp[3]) : '', tp[4]].filter(Boolean).join(' ');
}

// Rebuilt only when the choices change, so an open picker isn't disturbed.
function setOptions(select: HTMLSelectElement, options: SharedOption[], value: string): void {
  const key = JSON.stringify(options);
  if (select.dataset.options !== key) {
    select.dataset.options = key;
    select.textContent = '';
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }
  }
  select.value = value;
}

function setSegments(group: HTMLElement, options: SharedOption[], value: string, disabled: boolean): void {
  const key = JSON.stringify(options);
  if (group.dataset.options !== key) {
    group.dataset.options = key;
    group.textContent = '';
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.value = option.value;
      button.textContent = option.label;
      group.appendChild(button);
    }
  }
  group.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.value === value ? 'true' : 'false');
    button.disabled = disabled;
  });
}

function setText(input: HTMLInputElement, value: string, valid: boolean): void {
  if (document.activeElement !== input && input.value !== value) input.value = value;
  input.setAttribute('aria-invalid', valid ? 'false' : 'true');
}

export class TuningPanel {
  private settings: SettingsMessage | null = null;
  private draft: Draft | null = null;
  private sent: { req: string; phase: SendPhase } | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  private labels: ViewerLabels | null = null;
  private live = false;

  constructor(
    private readonly send: (message: ApplyMessage) => boolean,
    private readonly newReq: () => string,
  ) {
    el<HTMLSelectElement>('f-satellite').addEventListener('change', (event) => {
      if (this.draft && this.settings) {
        this.edit(pickSatellite(this.draft, this.settings, Number((event.target as HTMLSelectElement).value)));
      }
    });
    el<HTMLSelectElement>('f-lnb').addEventListener('change', (event) => {
      if (this.draft) this.edit({ ...this.draft, lnb: Number((event.target as HTMLSelectElement).value) });
    });
    el<HTMLSelectElement>('f-tp').addEventListener('change', (event) => {
      if (this.draft && this.settings) {
        this.edit(pickTransponder(this.draft, this.settings, Number((event.target as HTMLSelectElement).value)));
      }
    });
    el<HTMLInputElement>('f-power').addEventListener('change', (event) => {
      if (this.draft) this.edit({ ...this.draft, lnbPower: (event.target as HTMLInputElement).checked });
    });
    this.bindText('f-frequency', 'frequency');
    this.bindText('f-symbol-rate', 'symbolRate');
    this.bindSegments('f-diseqc', value => (this.draft ? { ...this.draft, diseqc: value } : null));
    this.bindSegments('f-tone', value => (this.draft ? { ...this.draft, tone: value } : null));
    this.bindSegments('f-pol', value => (this.draft
      ? editForm(this.draft, { polarization: value === 'V' ? 'V' : 'H' }) : null));
    this.bindSegments('f-system', value => (this.draft
      ? editForm(this.draft, { system: value === 'DVB-S' ? 'DVB-S' : 'DVB-S2' }) : null));
    el('send').addEventListener('click', () => this.sendDraft());
    el('cancel').addEventListener('click', () => {
      if (!this.settings) return;
      this.draft = draftFrom(this.settings);
      this.sent = null;
      this.render();
    });
  }

  onSettings(settings: SettingsMessage): void {
    this.draft = rebase(this.draft, this.settings, settings);
    this.settings = settings;
    const ack = settings.ack;
    if (this.sent && this.sent.phase === 'sending' && ack && ack.req === this.sent.req) {
      this.sent = { req: ack.req, phase: ack.ok ? 'applied' : 'notApplied' };
      this.clearAnswerTimer();
    }
    this.render();
  }

  // The editor takes changes only while the TV shares.
  update(labels: ViewerLabels, live: boolean): void {
    this.labels = labels;
    this.live = live;
    this.render();
  }

  private bindText(id: string, field: keyof FormPatch): void {
    el<HTMLInputElement>(id).addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      const digits = input.value.replace(/\D/g, '');
      if (digits !== input.value) input.value = digits;
      if (this.draft) this.edit(editForm(this.draft, { [field]: digits }));
    });
  }

  private bindSegments(id: string, next: (value: string) => Draft | null): void {
    el(id).addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]');
      const draft = button && !button.disabled ? next(button.dataset.value ?? '') : null;
      if (draft) this.edit(draft);
    });
  }

  private edit(draft: Draft): void {
    this.draft = draft;
    // A new edit replaces the last send's answer.
    if (this.sent && this.sent.phase !== 'sending') this.sent = null;
    this.render();
  }

  private sendDraft(): void {
    const draft = this.draft;
    if (!draft || !this.live || (this.sent && this.sent.phase === 'sending')) return;
    const req = this.newReq();
    const message = applyMessage(draft, req);
    if (!message || !this.send(message)) return;
    this.sent = { req, phase: 'sending' };
    this.clearAnswerTimer();
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null;
      if (this.sent && this.sent.req === req && this.sent.phase === 'sending') {
        this.sent = { req, phase: 'noAnswer' };
        this.render();
      }
    }, ANSWER_MS);
    this.render();
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = null;
  }

  private render(): void {
    const settings = this.settings;
    const draft = this.draft;
    const labels = this.labels;
    el('tuning').hidden = !settings || !draft || !labels;
    if (!settings || !draft || !labels) return;
    const satellite = satelliteIn(settings, draft.satellite);
    if (!satellite) return;
    const sending = !!this.sent && this.sent.phase === 'sending';
    el<HTMLFieldSetElement>('tuning-fields').disabled = !this.live || sending;

    setOptions(el<HTMLSelectElement>('f-satellite'),
      settings.satellites.map(item => ({ value: String(item.id), label: item.name || String(item.id) })),
      String(draft.satellite));
    const lnbs = settings.lnbs.map((lnb, index) => ({ value: String(index), label: lnb.label }));
    // An LNB the TV has that the presets don't name stays pickable.
    if (draft.lnb < 0) lnbs.unshift({ value: '-1', label: satellite.lnbLabel || '–' });
    setOptions(el<HTMLSelectElement>('f-lnb'), lnbs, String(draft.lnb));
    setSegments(el('f-diseqc'), settings.diseqcs.map(item => ({ value: item.value, label: item.label || labels.off })),
      draft.diseqc, false);
    const locked = toneLocked(draft, settings);
    const tones = settings.tones.map(item => ({ value: item.value, label: item.label || labels.off }));
    setSegments(el('f-tone'), tones, locked && tones.length ? tones[0].value : draft.tone, locked);
    el<HTMLInputElement>('f-power').checked = draft.lnbPower;

    setOptions(el<HTMLSelectElement>('f-tp'), [
      { value: '0', label: labels.newTransponder },
      ...satellite.tps.map(tp => ({ value: String(tp[0]), label: tpLabel(tp) })),
    ], String(draft.tp));
    el('f-frequency-field').hidden = draft.tp !== 0;
    const frequencyOk = numberIn(draft.frequency, FREQUENCY_RANGE) !== null;
    const symbolRateOk = numberIn(draft.symbolRate, SYMBOL_RATE_RANGE) !== null;
    setText(el<HTMLInputElement>('f-frequency'), draft.frequency, frequencyOk);
    setText(el<HTMLInputElement>('f-symbol-rate'), draft.symbolRate, symbolRateOk);
    setSegments(el('f-pol'), [
      { value: 'H', label: labels.horizontal },
      { value: 'V', label: labels.vertical },
    ], draft.polarization, false);
    setSegments(el('f-system'), [
      { value: 'DVB-S', label: 'DVB-S' },
      { value: 'DVB-S2', label: 'DVB-S2' },
    ], draft.system, false);

    const dirty = isDirty(draft, settings);
    const phase = this.sent ? this.sent.phase : null;
    el<HTMLButtonElement>('send').disabled = !this.live || sending || !dirty || !frequencyOk || !symbolRateOk;
    el('cancel').hidden = !dirty || sending;
    const status = el('send-status');
    status.textContent = phase ? labels[phase] : '';
    status.hidden = !phase;
    status.dataset.error = phase === 'notApplied' || phase === 'noAnswer' ? 'true' : 'false';
  }
}
