import qrcode from 'qrcode-generator';

// Views re-render often (the signal finder about every second) with the
// same link; encoding the image each time is wasted work on a TV.
let last: { text: string; url: string } | null = null;

/** Generate a PNG data URL containing a QR code for the given text. */
export function qrDataUrl(text: string): string {
  if (last && last.text === text) return last.url;
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  last = { text, url: qr.createDataURL(6, 4) };
  return last.url;
}
