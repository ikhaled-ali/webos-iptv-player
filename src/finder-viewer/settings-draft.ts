// The phone's edits to the finder's settings, kept apart from what the TV
// last shared until Send to TV. Number fields hold their typed text, so a
// half-typed value stays as typed.
import {
  FINDER_SHARE_VERSION,
  FREQUENCY_RANGE,
  SYMBOL_RATE_RANGE,
  type ApplyMessage,
  type SettingsMessage,
  type SharedPolarization,
  type SharedSatellite,
  type SharedSystem,
} from '../services/finder-share-protocol';

export interface Draft {
  satellite: number;
  lnb: number;
  diseqc: string;
  tone: string;
  lnbPower: boolean;
  // A listed transponder's id, or 0 for a new one.
  tp: number;
  frequency: string;
  symbolRate: string;
  polarization: SharedPolarization;
  system: SharedSystem;
}

export type FormPatch = Partial<Pick<Draft, 'frequency' | 'symbolRate' | 'polarization' | 'system'>>;

export function satelliteIn(settings: SettingsMessage, id: number): SharedSatellite | null {
  for (const satellite of settings.satellites) if (satellite.id === id) return satellite;
  return null;
}

function fromSatellite(satellite: SharedSatellite): Draft {
  return {
    satellite: satellite.id,
    lnb: satellite.lnb,
    diseqc: satellite.diseqc,
    tone: satellite.tone,
    lnbPower: satellite.lnbPower,
    tp: satellite.tp,
    frequency: String(satellite.form.frequency),
    symbolRate: String(satellite.form.symbolRate),
    polarization: satellite.form.polarization,
    system: satellite.form.system,
  };
}

// What the TV shows now.
export function draftFrom(settings: SettingsMessage): Draft {
  return fromSatellite(satelliteIn(settings, settings.satellite) as SharedSatellite);
}

export function numberIn(text: string, range: { min: number; max: number }): number | null {
  if (!/^\d{1,6}$/.test(text)) return null;
  const value = parseInt(text, 10);
  return value >= range.min && value <= range.max ? value : null;
}

function sameNumber(a: string, b: string, range: { min: number; max: number }): boolean {
  return (numberIn(a, range) ?? a) === (numberIn(b, range) ?? b);
}

// The transponder is named by its fields; which listed record matches is
// the TV's call.
export function sameDraft(a: Draft, b: Draft): boolean {
  return a.satellite === b.satellite && a.lnb === b.lnb && a.diseqc === b.diseqc && a.tone === b.tone
    && a.lnbPower === b.lnbPower && a.polarization === b.polarization && a.system === b.system
    && sameNumber(a.frequency, b.frequency, FREQUENCY_RANGE) && sameNumber(a.symbolRate, b.symbolRate, SYMBOL_RATE_RANGE);
}

// New settings from the TV replace the draft unless the phone has edits
// of its own, which stay until sent or canceled.
export function rebase(draft: Draft | null, previous: SettingsMessage | null, next: SettingsMessage): Draft {
  if (!draft || !previous || !satelliteIn(next, draft.satellite) || sameDraft(draft, draftFrom(previous))) {
    return draftFrom(next);
  }
  return draft;
}

export function isDirty(draft: Draft | null, settings: SettingsMessage | null): boolean {
  return !!draft && !!settings && !sameDraft(draft, draftFrom(settings));
}

// Another satellite brings its own LNB setup and transponder.
export function pickSatellite(draft: Draft, settings: SettingsMessage, id: number): Draft {
  const satellite = satelliteIn(settings, id);
  return satellite && id !== draft.satellite ? fromSatellite(satellite) : draft;
}

// A listed transponder fills the form; 0 starts a new one from the form.
export function pickTransponder(draft: Draft, settings: SettingsMessage, tp: number): Draft {
  const satellite = satelliteIn(settings, draft.satellite);
  const entry = satellite ? satellite.tps.find(item => item[0] === tp) : undefined;
  if (!entry) return { ...draft, tp: 0 };
  return {
    ...draft,
    tp,
    frequency: String(entry[1]),
    polarization: entry[2],
    symbolRate: entry[3] ? String(entry[3]) : draft.symbolRate,
    system: entry[4] || draft.system,
  };
}

// Changing a listed transponder's fields makes it a new one, as on the TV.
export function editForm(draft: Draft, patch: FormPatch): Draft {
  const next = { ...draft, ...patch };
  const changed = (Object.keys(patch) as Array<keyof FormPatch>).some(key => patch[key] !== draft[key]);
  return changed ? { ...next, tp: 0 } : next;
}

// A universal LNB picks its band with the tone itself.
export function toneLocked(draft: Draft, settings: SettingsMessage): boolean {
  const lnb = settings.lnbs[draft.lnb];
  return !!lnb && lnb.universal;
}

export function applyMessage(draft: Draft, req: string): ApplyMessage | null {
  const frequency = numberIn(draft.frequency, FREQUENCY_RANGE);
  const symbolRate = numberIn(draft.symbolRate, SYMBOL_RATE_RANGE);
  if (frequency === null || symbolRate === null) return null;
  return {
    v: FINDER_SHARE_VERSION,
    req,
    satellite: draft.satellite,
    lnb: draft.lnb,
    diseqc: draft.diseqc,
    tone: draft.tone,
    lnbPower: draft.lnbPower,
    form: { frequency, polarization: draft.polarization, symbolRate, system: draft.system },
  };
}
