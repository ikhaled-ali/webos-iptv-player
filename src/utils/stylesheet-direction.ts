// The build writes a mirrored copy of every stylesheet to css/rtl/
// (scripts/css-transforms.mjs); a right-to-left language loads those instead.
const CSS_DIR = 'css/';
const RTL_DIR = 'css/rtl/';

export function stylesheetHref(href: string, rtl: boolean): string {
  const ltr = href.indexOf(RTL_DIR) === 0 ? CSS_DIR + href.slice(RTL_DIR.length) : href;
  if (ltr.indexOf(CSS_DIR) !== 0) return href;
  return rtl ? RTL_DIR + ltr.slice(CSS_DIR.length) : ltr;
}

export function applyStylesheetDirection(rtl: boolean): void {
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
  for (let i = 0; i < links.length; i++) {
    const href = links[i].getAttribute('href');
    if (!href) continue;
    const next = stylesheetHref(href, rtl);
    if (next !== href) links[i].setAttribute('href', next);
  }
}
