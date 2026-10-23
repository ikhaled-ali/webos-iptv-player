// Synthetic protected-key service for browser fixtures; never bundled with the app.
export function protectedKeymanagerMock() {
  const encode = (bytes) => {
    let result = '';
    for (const byte of bytes) result += String.fromCharCode(byte);
    return btoa(result);
  };
  const decode = (value) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
  const operations = new Map();
  const root = crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['encrypt', 'decrypt']);
  let counter = 0;
  window.__keymanagerMock = (uri, payload, respond) => {
    if (uri.indexOf('luna://com.webos.service.keymanager3/') !== 0 && uri.indexOf('luna://com.webos.service.tv.systemproperty/') !== 0) return false;
    const method = uri.slice(uri.lastIndexOf('/') + 1);
    const params = JSON.parse(payload);
    void (async () => {
      let result = { returnValue: true };
      if (method === 'getSystemInfo') result.sdkVersion = '10.3.2';
      if (method === 'generateKey' && Object.prototype.hasOwnProperty.call(params.params, 'mac_length')) {
        result = { returnValue: false, errorCode: -20033 };
      }
      if (method === 'begin') {
        const handle = String(++counter);
        const iv = params.params.iv ? decode(params.params.iv) : crypto.getRandomValues(new Uint8Array(12));
        operations.set(handle, { iv, decrypt: params.params.purpose[0] === 'decrypt' });
        result = { returnValue: true, handle, iv: encode(iv) };
      }
      if (method === 'finish') {
        const operation = operations.get(params.handle);
        const output = await crypto.subtle[operation.decrypt ? 'decrypt' : 'encrypt'](
          { name: 'AES-GCM', iv: operation.iv, tagLength: 128 }, await root, decode(params.data));
        operations.delete(params.handle);
        result.output = encode(new Uint8Array(output));
      }
      if (method === 'abort') operations.delete(params.handle);
      respond(JSON.stringify(result));
    })().catch(() => respond(JSON.stringify({ returnValue: false, errorCode: -20030 })));
    return true;
  };
}
