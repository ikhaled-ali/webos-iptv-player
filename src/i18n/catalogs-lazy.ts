// The app build's stand-in for catalogs.ts: no catalog is bundled, and each
// one arrives through its locale script instead (see loadLocale in index.ts).
import type { MessageCatalog } from './en';

export const BUNDLED_CATALOGS: Record<string, Readonly<MessageCatalog>> = {};
