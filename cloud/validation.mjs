export class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message); this.status = status; this.details = details;
  }
}

export function fields(value, allowed, label = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `Invalid ${label}.`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new HttpError(400, `Unexpected ${label} field. Only reading metadata is accepted.`);
}

export function string(value, max, label, { empty = false, pattern } = {}) {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (pattern && !pattern.test(value))) {
    throw new HttpError(400, `Invalid ${label}.`);
  }
  return value;
}

export const identifier = (value, label = 'book identifier') => string(value, 200, label, { pattern: /^[A-Za-z0-9._:-]+$/ });

// Accept only WebRTC data-channel description fields produced by browsers and
// aiortc. No free-form session text, media tracks, URLs, or encoded files.
export function transferDescription(value, type) {
  fields(value, ['type', 'sdp'], 'connection description');
  if (value.type !== type) throw new HttpError(400, 'Invalid connection description type.');
  if (typeof value.sdp !== 'string' || value.sdp.length > 32768 || /[^\x20-\x7e\r\n]/.test(value.sdp)) {
    throw new HttpError(400, 'Invalid connection description.');
  }
  const lines = value.sdp.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const address = '(?:[A-Fa-f0-9:.]+|[A-Za-z0-9-]+\\.local)';
  const candidate = new RegExp(`^a=candidate:[A-Za-z0-9+/]{1,64} [12] (?:udp|tcp|UDP|TCP) \\d{1,10} ${address} \\d{1,5} typ (?:host|srflx|prflx|relay)(?: (?:raddr ${address}|rport \\d{1,5}|tcptype (?:active|passive|so)|generation \\d{1,10}|ufrag [A-Za-z0-9+/]{1,256}|network-id \\d{1,10}|network-cost \\d{1,10}))*$`);
  const allowed = [
    /^v=0$/, /^o=-?\d* \d+ \d+ IN IP[46] [A-Fa-f0-9:.]+$/, /^s=-$/, /^t=0 0$/,
    /^m=application \d{1,5} (?:UDP\/DTLS\/SCTP webrtc-datachannel|DTLS\/SCTP \d{1,5})$/,
    /^c=IN IP[46] [A-Fa-f0-9:.]+$/, /^a=group:BUNDLE [A-Za-z0-9_-]{1,32}$/,
    /^a=msid-semantic:\s*WMS(?: \*)?$/, /^a=extmap-allow-mixed$/,
    /^a=mid:[A-Za-z0-9_-]{1,32}$/, /^a=ice-ufrag:[A-Za-z0-9+/]{1,256}$/,
    /^a=ice-pwd:[A-Za-z0-9+/]{1,256}$/, /^a=ice-options:(?:trickle|renomination)(?: (?:trickle|renomination))*$/,
    /^a=fingerprint:sha-(?:256|384|512) (?:[A-Fa-f0-9]{2}:){31,63}[A-Fa-f0-9]{2}$/,
    /^a=setup:(?:actpass|active|passive)$/, /^a=sctp-port:\d{1,5}$/,
    /^a=sctpmap:\d{1,5} webrtc-datachannel \d{1,5}$/, /^a=max-message-size:\d{1,10}$/,
    /^a=end-of-candidates$/, candidate,
  ];
  if (!lines.length || lines.length > 128 || lines.some((line) => line.length > 512 || !allowed.some((rule) => rule.test(line)))
      || lines.filter((line) => line.startsWith('m=')).length !== 1
      || ['v=', 'o=', 's=', 't=', 'a=ice-ufrag:', 'a=ice-pwd:', 'a=fingerprint:', 'a=setup:'].some((prefix) => !lines.some((line) => line.startsWith(prefix)))) {
    throw new HttpError(400, 'Only a WebRTC data-channel connection description is accepted.');
  }
  return { type, sdp: lines.join('\r\n') + '\r\n' };
}

export function transferRequest(value) {
  fields(value, ['kind', 'bookId', 'bookIds', 'offer'], 'transfer');
  if (value.kind !== undefined && !['epub', 'covers'].includes(value.kind)) throw new HttpError(400, 'Invalid transfer kind.');
  const bookId = identifier(value.bookId);
  if (value.kind === 'covers') {
    if (!Array.isArray(value.bookIds) || !value.bookIds.length || value.bookIds.length > 200) {
      throw new HttpError(400, 'Choose between 1 and 200 books for cover sync.');
    }
    const bookIds = value.bookIds.map((id) => identifier(id));
    if (bookIds[0] !== bookId || new Set(bookIds).size !== bookIds.length) {
      throw new HttpError(400, 'Cover sync needs unique books with the first book as its anchor.');
    }
    return { kind: 'covers', bookId, bookIds, offer: transferDescription(value.offer, 'offer') };
  }
  if (Object.hasOwn(value, 'bookIds')) throw new HttpError(400, 'EPUB transfers accept one book only.');
  return { bookId, offer: transferDescription(value.offer, 'offer') };
}

export function transferAnswer(value) {
  fields(value, ['answer', 'error'], 'transfer answer');
  if (Object.hasOwn(value, 'answer') === Object.hasOwn(value, 'error')) throw new HttpError(400, 'Provide a connection answer or a transfer error.');
  if (Object.hasOwn(value, 'answer')) return { answer: transferDescription(value.answer, 'answer'), error: null };
  if (!['BOOK_UNAVAILABLE', 'TRANSFER_FAILED', 'BOOK_TOO_LARGE'].includes(value.error)) throw new HttpError(400, 'Invalid transfer error.');
  return { answer: null, error: value.error };
}
export const cfi = (value) => string(value, 8192, 'EPUB position', { pattern: /^epubcfi\([^\x00-\x1f]+\)$/ });
export function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `Invalid ${label}.`);
  return value;
}
function fraction(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new HttpError(400, 'Reading percentage must be between zero and one.');
  return value;
}
function timestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new HttpError(400, 'Invalid timestamp.');
  return new Date(value).toISOString();
}

export function position(value) {
  fields(value, ['cfi', 'clientId', 'sequence', 'baseRevision', 'appleRevision', 'href', 'percentage'], 'position');
  if (value.href != null) {
    string(value.href, 2048, 'chapter reference', { empty: true });
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(value.href) || value.href.includes('\\')) {
      throw new HttpError(400, 'Chapter references must be relative to the EPUB.');
    }
  }
  return {
    cfi: cfi(value.cfi), clientId: string(value.clientId, 100, 'reader session', { pattern: /^[A-Za-z0-9_-]+$/ }),
    sequence: integer(value.sequence, 'sequence'), baseRevision: integer(value.baseRevision, 'base revision'),
    appleRevision: value.appleRevision === null ? null : string(value.appleRevision, 200, 'Apple revision'),
    href: value.href == null ? null : string(value.href, 2048, 'chapter reference', { empty: true }),
    percentage: value.percentage == null ? null : fraction(value.percentage),
  };
}

function applePosition(value) {
  if (value === null) return null;
  fields(value, ['cfi', 'updatedAt', 'revision'], 'Apple position');
  return { cfi: cfi(value.cfi), updatedAt: timestamp(value.updatedAt), revision: string(value.revision, 200, 'Apple revision') };
}

function annotation(value) {
  fields(value, ['id', 'type', 'cfi', 'text', 'note', 'color'], 'annotation');
  if (!['highlight', 'bookmark'].includes(value.type)) throw new HttpError(400, 'Invalid annotation type.');
  if (!['green', 'blue', 'yellow', 'pink', 'purple'].includes(value.color)) throw new HttpError(400, 'Invalid annotation color.');
  return {
    id: identifier(value.id, 'annotation identifier'), type: value.type, cfi: cfi(value.cfi),
    text: string(value.text, 32_768, 'highlight text', { empty: true }),
    note: string(value.note, 32_768, 'note', { empty: true }), color: value.color,
  };
}

export function snapshot(value) {
  fields(value, ['sequence', 'books'], 'snapshot');
  const sequence = integer(value.sequence, 'snapshot sequence');
  if (!Array.isArray(value.books) || value.books.length > 200) throw new HttpError(400, 'A snapshot accepts at most 200 books.');
  const seen = new Set();
  const books = value.books.map((book) => {
    fields(book, ['id', 'title', 'author', 'progress', 'lastReadAt', 'availableOnMac', 'applePosition', 'annotations'], 'book');
    const id = identifier(book.id);
    if (seen.has(id)) throw new HttpError(400, 'Duplicate book in snapshot.');
    seen.add(id);
    if (typeof book.availableOnMac !== 'boolean' || !Array.isArray(book.annotations) || book.annotations.length > 10_000) throw new HttpError(400, 'Invalid book metadata.');
    const annotations = book.annotations.map(annotation);
    if (new Set(annotations.map((item) => item.id)).size !== annotations.length) throw new HttpError(400, 'Duplicate annotation.');
    return {
      id, title: string(book.title, 1000, 'title'), author: string(book.author, 1000, 'author', { empty: true }),
      progress: fraction(book.progress), lastReadAt: timestamp(book.lastReadAt), availableOnMac: book.availableOnMac,
      applePosition: applePosition(book.applePosition), annotations,
    };
  });
  return { sequence, books };
}

export async function jsonBody(request, limit = 16_384) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'Send JSON reading metadata.');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new HttpError(413, 'Request is too large.');
  if (!request.body) throw new HttpError(400, 'Expected JSON.');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON.');
  } finally { reader.releaseLock(); }
}
