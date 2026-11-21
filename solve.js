// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly what csv-reader
// returns for {text, header} — {columns, rows, errors} — on every input, broken
// rows included. One left-to-right pass; plain fields are cut out with indexOf
// and slice instead of being built up a character at a time, which is where
// the reference spends its time. Pure: nothing kept from one call to the next.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, and the index in rows it takes
  // (null while the header is still unread).
  let recordLine = 1;
  let recordRow = null;
  // How the last field read ended.
  let ended = END;

  // Reads an unquoted field onto `value`, up to the next comma or line break.
  // A CR not followed by LF is dropped (stray_cr). Returns the field; `ended`
  // says how it ended. Only the rare stray CR splits the field into segments.
  function readUnquoted(value) {
    for (;;) {
      const iC = text.indexOf(',', pos);
      const iN = text.indexOf('\n', pos);
      let m;
      let delim;
      if (iC === -1 && iN === -1) {
        m = n;
        delim = END;
      } else if (iN === -1 || (iC !== -1 && iC < iN)) {
        m = iC;
        delim = COMMA;
      } else {
        m = iN;
        delim = LINE_BREAK;
      }
      let end = m;
      if (delim === LINE_BREAK && m > pos && text.charCodeAt(m - 1) === 13) end = m - 1;
      const seg = text.slice(pos, end);
      const r = seg.indexOf('\r');
      if (r !== -1) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += seg.slice(0, r);
        pos = pos + r + 1;
        continue;
      }
      value += seg;
      if (delim === COMMA) {
        pos = m + 1;
        ended = COMMA;
      } else if (delim === LINE_BREAK) {
        pos = m + 1;
        line += 1;
        ended = LINE_BREAK;
      } else {
        pos = n;
        ended = END;
      }
      return value;
    }
  }

  // A quoted segment [from, to), with CRLF and lone CR inside it read as LF
  // and every line break counted. The common case — no line break at all — is
  // one slice.
  function segVal(from, to) {
    if (from >= to) return '';
    const s = text.slice(from, to);
    if (s.indexOf('\r') === -1) {
      let c = 0;
      let i = s.indexOf('\n');
      while (i !== -1) {
        c += 1;
        i = s.indexOf('\n', i + 1);
      }
      line += c;
      return s;
    }
    const norm = s.replace(/\r\n?/g, '\n');
    let c = 0;
    let i = norm.indexOf('\n');
    while (i !== -1) {
      c += 1;
      i = norm.indexOf('\n', i + 1);
    }
    line += c;
    return norm;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let seg = pos;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote.
        value += segVal(seg, q);
        value += '"';
        pos = q + 2;
        seg = q + 2;
        continue;
      }
      // The closing quote.
      value += segVal(seg, q);
      pos = q + 1;
      if (pos >= n) {
        ended = END;
        return value;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        ended = COMMA;
        return value;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break; quote_junk when the field ends.
      const junk = readUnquoted(value);
      if (junk.length > value.length) {
        errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      return junk;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    // Fast path: a whole record with no quote and no stray CR is plain
    // unquoted fields — one split instead of a scan per field. A quote
    // anywhere in the line means a quoted field (the generator only ever
    // puts a quote in a line that opens one), and a CR anywhere but the
    // trailing CRLF one is a stray CR, so both send the record to the
    // slow path, which handles them exactly.
    const iN = text.indexOf('\n', pos);
    const lineEnd = iN === -1 ? n : iN;
    let lineStop = lineEnd;
    if (iN !== -1 && lineStop > pos && text.charCodeAt(lineStop - 1) === 13) lineStop -= 1;
    const raw = text.slice(pos, lineStop);
    if (raw.indexOf('"') === -1 && raw.indexOf('\r') === -1) {
      const parts = raw.split(',');
      for (let i = 0; i < parts.length; i++) fields.push(parts[i]);
      if (iN === -1) {
        pos = n;
      } else {
        pos = iN + 1;
        line += 1;
      }
    } else {
      do {
        quoted = text.charCodeAt(pos) === 34;
        fields.push(quoted ? readQuoted() : readUnquoted(''));
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
