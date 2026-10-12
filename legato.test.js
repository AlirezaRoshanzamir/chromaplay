import test from 'node:test';
import assert from 'node:assert/strict';
import { convertSheetToMusicXml, validateSheetFile, LEGATO_TIMEOUT_MS, MAX_SHEET_BYTES } from './legato.js';

const API = 'https://guangyangmusic-legato-demo.hf.space/gradio_api';
const ABC = 'X:1\nT:Example\nM:4/4\nL:1/4\nK:C\nC D E F |';
const XML = '<?xml version="1.0"?><score-partwise version="4.0"><part-list/></score-partwise>';
const output = { path: '/tmp/gradio/result/score.musicxml', url: `${API}/file=/tmp/gradio/result/score.musicxml`, size: XML.length };
const sheet = () => new File(['sheet bytes'], 'score.png', { type: 'image/png' });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const complete = value => new Response(`event: complete\ndata: ${JSON.stringify(value)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });

function makeFlow(overrides = {}) {
  const replies = [() => json(['/tmp/gradio/upload/score.png']), () => json({ event_id: 'recognize-123' }),
    () => complete([ABC]), () => json({ event_id: 'convert-456' }), () => complete([output]), () => new Response(XML)];
  const calls = [];
  const fetchImpl = async (url, options) => {
    const index = calls.length;
    calls.push({ url, options });
    assert.ok(index < replies.length, 'no automatic retries or unexpected requests');
    return (overrides[index] || replies[index])(url, options);
  };
  return { fetchImpl, calls };
}

function chunks(parts, onCancel = () => {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); },
    cancel: onCancel,
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('validates supported sheet formats, MIME types, empty files and size before uploading', () => {
  for (const [name, type] of [['sheet.png', 'image/png'], ['sheet.JPG', 'image/jpeg'], ['sheet.jpeg', ''],
    ['sheet.webp', 'image/webp'], ['sheet.pdf', 'application/pdf'], ['sheet.pdf', 'application/octet-stream']]) {
    const file = new File(['data'], name, { type });
    assert.equal(validateSheetFile(file), file);
  }
  for (const file of [null, {}, { name: 'score.png', size: NaN }, new File(['x'], 'score.gif', { type: 'image/gif' }),
    new File(['x'], 'score.pdf', { type: 'text/html' }), new File([], 'score.png')]) assert.throws(() => validateSheetFile(file));
  assert.doesNotThrow(() => validateSheetFile({ name: 'score.pdf', type: 'application/pdf', size: MAX_SHEET_BYTES }));
  assert.throws(() => validateSheetFile({ name: 'score.pdf', size: MAX_SHEET_BYTES + 1 }), /16 MB/);
});

test('uploads the chosen file, recognizes ABC and downloads MusicXML without credentials or redirects', async () => {
  const { fetchImpl, calls } = makeFlow();
  const progress = [];
  assert.deepEqual(await convertSheetToMusicXml(sheet(), { fetchImpl, onProgress: message => progress.push(message) }), { musicxml: XML, abc: ABC });
  assert.deepEqual(calls.map(call => call.url), [`${API}/upload`, `${API}/call/run_legato`, `${API}/call/run_legato/recognize-123`,
    `${API}/call/abc_to_musicxml_file`, `${API}/call/abc_to_musicxml_file/convert-456`, output.url]);
  assert.equal(calls[0].options.body.get('files').name, 'score.png');
  assert.deepEqual([...calls[0].options.body.keys()], ['files']);
  assert.deepEqual(JSON.parse(calls[1].options.body), { data: [{ path: '/tmp/gradio/upload/score.png', orig_name: 'score.png', meta: { _type: 'gradio.FileData' } }] });
  assert.deepEqual(JSON.parse(calls[3].options.body), { data: [ABC] });
  for (const { options } of calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(progress.length, 4);
  assert.ok(progress.every(message => typeof message === 'string' && !message.includes('%')));
});

test('reads split CRLF events and UTF-8 without treating heartbeat or generating events as results', async () => {
  let canceled = false;
  const abc = `${ABC}\n% café`;
  const bytes = new TextEncoder().encode(`: keepalive\r\nevent: heartbeat\r\ndata: null\r\n\r\nevent: generating\r\ndata: ["partial"]\r\n\r\nevent: complete\r\ndata: ${JSON.stringify([abc])}\r\n\r\n`);
  const { fetchImpl } = makeFlow({ 2: () => new Response(new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); },
    cancel() { canceled = true; },
  })) });
  assert.equal((await convertSheetToMusicXml(sheet(), { fetchImpl })).abc, abc);
  assert.equal(canceled, true, 'finishing a result closes the stream');
});

test('handles multiple SSE data lines and a final complete event at EOF', async () => {
  const { fetchImpl } = makeFlow({ 2: () => new Response(`event: complete\ndata: [\ndata: ${JSON.stringify(ABC)}\ndata: ]`) });
  assert.equal((await convertSheetToMusicXml(sheet(), { fetchImpl })).abc, ABC);
});

test('service failures explain quota, startup, access and network problems without retrying', async t => {
  for (const [status, expected] of [[429, /quota/], [503, /temporarily unavailable/], [403, /anonymous access/], [500, /500.*service failed/]]) {
    await t.test(`HTTP ${status}`, async () => {
      const { fetchImpl, calls } = makeFlow({ 0: () => new Response(JSON.stringify({ detail: 'service failed' }), { status }) });
      await assert.rejects(convertSheetToMusicXml(sheet(), { fetchImpl }), expected);
      assert.equal(calls.length, 1);
    });
  }
  await assert.rejects(convertSheetToMusicXml(sheet(), { fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) }), /connect to LEGATO/);
});

test('null SSE errors and null XML outputs are readable service failures', async () => {
  for (const event of ['event: error\ndata: null\n\n', 'event: error\ndata: "GPU quota exceeded"\n\n']) {
    const { fetchImpl, calls } = makeFlow({ 2: () => new Response(event) });
    await assert.rejects(convertSheetToMusicXml(sheet(), { fetchImpl }), /quota/);
    assert.equal(calls.length, 3);
  }
  const { fetchImpl, calls } = makeFlow({ 4: () => complete([null]) });
  await assert.rejects(convertSheetToMusicXml(sheet(), { fetchImpl }), /could not turn.*MusicXML/);
  assert.equal(calls.length, 5);
});

test('service error text is stripped of markup and control characters and bounded', async () => {
  const message = '<b>Recognition failed</b>\u0000\n' + 'details '.repeat(200);
  const { fetchImpl } = makeFlow({ 2: () => new Response(`event: error\ndata: ${JSON.stringify({ message })}\n\n`) });
  await assert.rejects(convertSheetToMusicXml(sheet(), { fetchImpl }), error => {
    assert.match(error.message, /Recognition failed/);
    assert.ok(error.message.length <= 500);
    assert.doesNotMatch(error.message, /[<>\u0000\n]/);
    return true;
  });
});

test('refuses malformed API responses, truncated streams and empty recognition results', async t => {
  const cases = [
    [{ 0: () => new Response('not json') }, /invalid API response/],
    [{ 0: () => json(['https://example.com/sheet.png']) }, /did not accept/],
    [{ 1: () => json({ event_id: '../other' }) }, /did not start/],
    [{ 2: () => new Response('event: heartbeat\ndata: null\n\n') }, /ended before/],
    [{ 2: () => new Response('event: complete\ndata: broken\n\n') }, /invalid conversion/],
    [{ 2: () => complete({ result: ABC }) }, /invalid conversion/],
    [{ 2: () => complete(['   ']) }, /did not recognize/],
    [{ 5: () => new Response('<html>Service unavailable</html>') }, /did not return a MusicXML/],
  ];
  for (const [overrides, expected] of cases) await t.test(expected.source, async () => {
    await assert.rejects(convertSheetToMusicXml(sheet(), makeFlow(overrides)), expected);
  });
});

test('only downloads file results from the fixed LEGATO origin and file endpoint', async t => {
  for (const url of ['https://example.com/score.musicxml', 'https://guangyangmusic-legato-demo.hf.space.evil.test/gradio_api/file=/tmp/x',
    `${API}/other`, `${output.url}?redirect=https://example.com`, `${output.url}#fragment`,
    'https://user:password@guangyangmusic-legato-demo.hf.space/gradio_api/file=/tmp/x', 'file:///tmp/score.musicxml', 'javascript:alert(1)']) {
    await t.test(url, async () => {
      const { fetchImpl, calls } = makeFlow({ 4: () => complete([{ ...output, url }]) });
      await assert.rejects(convertSheetToMusicXml(sheet(), { fetchImpl }), /unexpected download address/);
      assert.equal(calls.length, 5, 'untrusted address is never fetched');
    });
  }
  const { fetchImpl, calls } = makeFlow({ 4: () => complete([{ path: '/tmp/gradio/result/score.musicxml' }]) });
  await convertSheetToMusicXml(sheet(), { fetchImpl });
  assert.equal(calls.at(-1).url, output.url, 'a path-only FileData uses the fixed host');
});

test('caps event buffers, recognized notation and downloaded score size', async t => {
  const cases = [
    [{ 2: () => complete(['a'.repeat(1_000_001)]) }, /recognized score is too large/],
    [{ 2: () => chunks(['event: complete\ndata: ' + 'a'.repeat(2_000_001)]) }, /recognized score is too large/],
    [{ 4: () => complete([{ ...output, size: 9 * 1024 * 1024 }]) }, /MusicXML is too large/],
    [{ 5: () => new Response(XML, { headers: { 'Content-Length': String(9 * 1024 * 1024) } }) }, /response that is too large/],
    [{ 5: () => new Response(XML + ' '.repeat(2_000_001)) }, /response that is too large/],
    [{ 0: () => new Response('a'.repeat(65_537)) }, /response that is too large/],
  ];
  for (const [overrides, expected] of cases) await t.test(expected.source, async () => {
    await assert.rejects(convertSheetToMusicXml(sheet(), makeFlow(overrides)), expected);
  });
});

test('an already canceled request never uploads', async () => {
  const controller = new AbortController(); controller.abort();
  const { fetchImpl, calls } = makeFlow();
  await assert.rejects(convertSheetToMusicXml(sheet(), { signal: controller.signal, fetchImpl }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('canceling an upload rejects promptly even if the request never settles', async () => {
  const controller = new AbortController();
  let requestSignal;
  const converting = convertSheetToMusicXml(sheet(), { signal: controller.signal, fetchImpl: (_url, options) => {
    requestSignal = options.signal;
    return new Promise(() => {});
  } });
  controller.abort();
  await assert.rejects(converting, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, true);
});

test('canceling while waiting for recognition closes the stream and never starts XML conversion', async () => {
  const controller = new AbortController();
  let canceled = false;
  let streamOpened;
  const opened = new Promise(resolve => { streamOpened = resolve; });
  const { fetchImpl, calls } = makeFlow({ 2: () => {
    streamOpened();
    return chunks(['event: heartbeat\ndata: null\n\n'], () => { canceled = true; });
  } });
  const converting = convertSheetToMusicXml(sheet(), { signal: controller.signal, fetchImpl });
  await opened;
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(converting, { name: 'AbortError' });
  assert.equal(canceled, true);
  assert.equal(calls.length, 3);
});

test('canceling during the XML download never returns a late score', async () => {
  const controller = new AbortController();
  const { fetchImpl } = makeFlow({ 5: () => {
    controller.abort();
    return new Response(XML);
  } });
  await assert.rejects(convertSheetToMusicXml(sheet(), { signal: controller.signal, fetchImpl }), { name: 'AbortError' });
});

test('the overall deadline aborts pending work and clears its timer', async t => {
  let trigger, cleared = false;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, LEGATO_TIMEOUT_MS);
    trigger = callback;
    return 123;
  });
  t.mock.method(globalThis, 'clearTimeout', id => { assert.equal(id, 123); cleared = true; });
  const converting = convertSheetToMusicXml(sheet(), { fetchImpl: () => new Promise(() => {}) });
  trigger();
  await assert.rejects(converting, /longer than 10 minutes/);
  assert.equal(cleared, true);
});
