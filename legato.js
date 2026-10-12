export const LEGATO_SPACE_URL = 'https://huggingface.co/spaces/guangyangmusic/legato-demo';
export const MAX_SHEET_BYTES = 16 * 1024 * 1024;
export const LEGATO_TIMEOUT_MS = 10 * 60 * 1000;

const SPACE_ORIGIN = 'https://guangyangmusic-legato-demo.hf.space';
const API = `${SPACE_ORIGIN}/gradio_api`;
const MAX_ABC_LENGTH = 1_000_000;
const MAX_MUSICXML_LENGTH = 2_000_000;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_LENGTH = 2_000_000;
const FILE_TYPES = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'], ['pdf', 'application/pdf'],
]);

export function validateSheetFile(file) {
  if (!file || typeof file.name !== 'string' || !Number.isFinite(file.size)) throw new Error('Choose a sheet image or PDF.');
  const extension = file.name.split('.').at(-1).toLowerCase();
  const expectedType = FILE_TYPES.get(extension);
  const type = (file.type || '').toLowerCase();
  if (!file.name.includes('.') || !expectedType || (type && type !== 'application/octet-stream' && type !== expectedType)) {
    throw new Error('Choose a PNG, JPG, WEBP, or PDF file.');
  }
  if (file.size <= 0) throw new Error('This file is empty. Choose a sheet image or PDF.');
  if (file.size > MAX_SHEET_BYTES) throw new Error('The sheet file is too large. Choose a file up to 16 MB.');
  return file;
}

function abortError() {
  return new DOMException('Sheet conversion was canceled in this browser.', 'AbortError');
}

function checkAbort(signal) {
  if (signal.aborted) throw abortError();
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function cleanMessage(value) {
  const text = typeof value === 'string' ? value : value?.message || value?.error || value?.detail;
  return typeof text === 'string' ? text.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) : '';
}

function serviceError(value) {
  const message = cleanMessage(value);
  if (/quota|rate.?limit|gpu.*(?:busy|unavailable)|exceeded/i.test(message)) {
    return new Error(`LEGATO's shared service is busy or its GPU quota has been reached. Wait and try again. ${message}`.trim().slice(0, 500));
  }
  return new Error(message ? `LEGATO: ${message}`.slice(0, 500) : 'LEGATO could not complete this request. Its shared GPU quota may be exhausted. Wait and try again, or open the LEGATO demo for details.');
}

async function readText(response, signal, maxBytes, maxCharacters = maxBytes) {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('LEGATO returned a file or response that is too large.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      checkAbort(signal);
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes > maxBytes || text.length > maxCharacters) throw new Error('LEGATO returned a file or response that is too large.');
    }
    text += decoder.decode();
    if (text.length > maxCharacters) throw new Error('LEGATO returned a file or response that is too large.');
    return text;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(url, options, context) {
  checkAbort(context.signal);
  const response = await abortable(context.fetchImpl(url, {
    ...options, signal: context.signal, credentials: 'omit', redirect: 'error',
  }), context.signal);
  checkAbort(context.signal);
  if (!response.ok) {
    let message;
    if (response.status === 429) message = "LEGATO's shared service has reached its request or GPU quota. Wait and try again, or open the LEGATO demo.";
    if ([502, 503, 504].includes(response.status)) message = 'LEGATO is starting up or is temporarily unavailable. Wait a minute and try again.';
    if ([401, 403].includes(response.status)) message = 'LEGATO refused anonymous access. Open the LEGATO demo to check its current access requirements.';
    if (response.status === 0) message = 'The browser could not reach LEGATO. Check your connection, or open the LEGATO demo and try again.';
    if (message) {
      void response.body?.cancel().catch(() => {});
      throw new Error(message);
    }
    const body = await readText(response, context.signal, 16_384);
    let detail;
    try { detail = JSON.parse(body); } catch { detail = body; }
    throw new Error(`LEGATO request failed (${response.status}). ${cleanMessage(detail)}`.trim().slice(0, 500));
  }
  return response;
}

async function jsonRequest(url, options, context) {
  const response = await request(url, options, context);
  try { return JSON.parse(await readText(response, context.signal, 65_536)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('LEGATO returned an invalid API response. Try again later.');
    throw error;
  }
}

function parseEvent(frame) {
  let event = 'message';
  const data = [];
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (event !== 'complete' && event !== 'error') return null;
  let value;
  try { value = JSON.parse(data.join('\n')); }
  catch { throw new Error('LEGATO returned an invalid conversion result. Try again.'); }
  if (event === 'error') throw serviceError(value);
  if (!Array.isArray(value)) throw new Error('LEGATO returned an invalid conversion result. Try again.');
  return value;
}

async function readResult(response, signal) {
  if (!response.body) throw new Error('LEGATO did not return a conversion stream. Try again.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      checkAbort(signal);
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > MAX_EVENT_LENGTH) throw new Error('The recognized score is too large. Try a smaller sheet.');
      let separator;
      while ((separator = /\r?\n\r?\n|\r\r/.exec(buffer))) {
        const result = parseEvent(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
        if (result) return result;
      }
      if (done) {
        const result = buffer.trim() ? parseEvent(buffer) : null;
        if (result) return result;
        throw new Error('The connection to LEGATO ended before conversion finished. Try again.');
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function call(endpoint, data, context) {
  const started = await jsonRequest(`${API}/call/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  }, context);
  if (typeof started.event_id !== 'string' || !/^[\w-]{1,200}$/.test(started.event_id)) throw new Error('LEGATO did not start the conversion. Try again later.');
  const response = await request(`${API}/call/${endpoint}/${started.event_id}`, { headers: { Accept: 'text/event-stream' } }, context);
  return readResult(response, context.signal);
}

function outputUrl(file) {
  if (!file || typeof file !== 'object') throw new Error('LEGATO could not turn the recognized notes into MusicXML. Try a clearer or smaller sheet.');
  let url;
  if (typeof file.url === 'string') {
    try { url = new URL(file.url, SPACE_ORIGIN); } catch { /* Rejected below. */ }
  } else if (typeof file.path === 'string' && file.path.startsWith('/tmp/')) {
    url = new URL(`${API}/file=${encodeURI(file.path).replace(/#/g, '%23').replace(/\?/g, '%3F')}`);
  }
  if (!url || url.origin !== SPACE_ORIGIN || !url.pathname.startsWith('/gradio_api/file=') || url.username || url.password || url.hash || url.search) {
    throw new Error('LEGATO returned an unexpected download address. No file was downloaded.');
  }
  return url.href;
}

/** Uploads only the selected sheet to the public demo. No tokens or app state are sent. */
export async function convertSheetToMusicXml(file, { signal, onProgress = () => {}, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  validateSheetFile(file);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let timedOut = false;
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timeout = setTimeout(() => { timedOut = true; cancel(); }, LEGATO_TIMEOUT_MS);
  const context = { signal: controller.signal, fetchImpl };
  try {
    checkAbort(context.signal);
    onProgress('Uploading the sheet to LEGATO...');
    const form = new FormData();
    form.append('files', file, file.name);
    const uploaded = await jsonRequest(`${API}/upload`, { method: 'POST', body: form }, context);
    if (!Array.isArray(uploaded) || typeof uploaded[0] !== 'string' || !uploaded[0].startsWith('/tmp/')) throw new Error('LEGATO did not accept the uploaded sheet. Try again.');
    checkAbort(context.signal);
    onProgress('LEGATO is recognizing the sheet. This can take a few minutes...');
    const [abc] = await call('run_legato', [{ path: uploaded[0], orig_name: file.name, meta: { _type: 'gradio.FileData' } }], context);
    if (typeof abc !== 'string' || !abc.trim()) throw new Error('LEGATO did not recognize any notes. Try a clearer sheet.');
    if (abc.length > MAX_ABC_LENGTH) throw new Error('The recognized score is too large. Try a smaller sheet.');
    checkAbort(context.signal);
    onProgress('Converting the recognized notes to MusicXML...');
    const [output] = await call('abc_to_musicxml_file', [abc], context);
    const url = outputUrl(output);
    if (Number(output.size) > MAX_XML_BYTES) throw new Error('The converted MusicXML is too large. Try a smaller sheet.');
    checkAbort(context.signal);
    onProgress('Downloading the MusicXML...');
    const response = await request(url, {}, context);
    const musicxml = await readText(response, context.signal, MAX_XML_BYTES, MAX_MUSICXML_LENGTH);
    if (!/<score-(?:partwise|timewise)\b/.test(musicxml)) throw new Error('LEGATO did not return a MusicXML score. Try another sheet.');
    checkAbort(context.signal);
    return { musicxml, abc };
  } catch (error) {
    if (timedOut) throw new Error('LEGATO took longer than 10 minutes. Try again later or use a smaller sheet.');
    if (context.signal.aborted) throw abortError();
    if (error instanceof TypeError) throw new Error('The browser could not connect to LEGATO. Check your connection, or open the LEGATO demo and try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
