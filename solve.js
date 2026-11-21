// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference program).
// run(input) returns exactly csv-reader's answer {columns, rows, errors} for
// every input {text, header}: same records, same strings, same errors in the
// same order. It is a fresh implementation of the policy in RULES.txt, written
// for speed: the reference walks one character at a time and builds every
// field a character at a time, while this one jumps between delimiters with
// indexOf/regex scans (C++ speed) and slices fields whole.
//
// The paths, in the order a record takes them:
// - a clean line (no quote and no stray CR in it) is split at once with
//   String.split(',');
// - any other line is parsed field by field: an unquoted field runs to the
//   next comma or LF found by indexOf, a quoted field runs to its closing
//   quote found by indexOf, and only a quoted field that actually holds a
//   line break pays for line counting and CR-to-LF conversion.
// A stray CR is rare, so whether the current line holds one is checked once
// per line (a bounded slice scan), not once per field.
//
// The hot loop allocates nothing per field: no result object, no regex match
// array. fieldEnded/fieldAdded carry a field's ending out of the readers.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Dependency-free, ES module, no WebAssembly, no native addon.

/** The next quote or CR at or after lastIndex (one C++ scan). */
const QUOTE_OR_CR = /["\r]/g;

const COMMA = 1;
const LINE_BREAK = 2;
const END = 3;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Errors met while reading it carry these.
  let recordLine = 1;
  let recordRow = null;

  // How the last field read ended, and how many characters were kept onto
  // it (readUnquoted's `added`: only the quote_junk check reads it).
  let fieldEnded = END;
  let fieldAdded = 0;

  // The line the stray-CR flag below was computed for, that line's end (the
  // next LF, or the end of the text), and whether it holds a CR that is not
  // its CRLF half.
  let flagLine = 0;
  let flagLineEnd = 0;
  let lineHasCr = false;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Whether the line starting at p (ending at its next LF, e, or the end of
  // the text) holds a CR that is not its CRLF half.
  function checkLineCr(p, e, hasLf) {
    if (e <= p) return false;
    const cr = text.slice(p, e).indexOf('\r');
    if (cr === -1) return false;
    // A CR at the very end of a line that ends in LF is that LF's CRLF half.
    if (hasLf && cr === e - p - 1) return false;
    return true;
  }

  // Refresh the stray-CR flag for the line the next field starts on, when a
  // quoted field has carried the reader onto a new line. A no-op when the
  // line has not changed.
  function refreshFlag() {
    if (line === flagLine) return;
    const nl2 = text.indexOf('\n', pos);
    flagLineEnd = nl2 === -1 ? n : nl2;
    flagLine = line;
    lineHasCr = checkLineCr(pos, flagLineEnd, nl2 !== -1);
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field;
  // fieldEnded says how it ended and fieldAdded how many characters were kept.
  // The next LF is flagLineEnd, the next LF from where the line's stray-CR
  // flag was computed: an unquoted field never crosses one, and the flag is
  // refreshed whenever a quoted field carries the reader onto a new line, so
  // no indexOf('\n') is needed here at all.
  function readUnquoted(value) {
    const startLen = value.length;
    for (;;) {
      const cIdx = text.indexOf(',', pos);
      const nIdx = flagLineEnd < n ? flagLineEnd : -1;
      let end;
      let ended;
      if (cIdx !== -1 && (nIdx === -1 || cIdx < nIdx)) {
        end = cIdx;
        ended = COMMA;
      } else if (nIdx !== -1) {
        end = nIdx;
        ended = LINE_BREAK;
      } else {
        end = n;
        ended = END;
      }
      if (lineHasCr) {
        const r = text.indexOf('\r', pos);
        if (r !== -1 && r < end) {
          value += text.slice(pos, r);
          if (text.charCodeAt(r + 1) === 10) {
            // CRLF: the field ends, the record ends.
            pos = r + 2;
            line += 1;
            fieldEnded = LINE_BREAK;
            fieldAdded = value.length - startLen;
            return value;
          }
          // A CR not followed by LF is dropped (stray_cr); the field goes on.
          error('stray_cr');
          pos = r + 1;
          continue;
        }
        // No CR left on this line before the field's end: only clear the
        // flag when the next CR is past this line (or there is none); a CR
        // later on this same line still belongs to a later field.
        if (r === -1 || r >= flagLineEnd) lineHasCr = false;
      }
      // A field ending at a LF whose previous character is a CR ends at a
      // CRLF: the CR is the line break's half, not part of the field. (The
      // stray-CR flag above deliberately ignores that one CR, so this strip
      // is what keeps it out of the value.)
      let sliceEnd = end;
      if (ended === LINE_BREAK && sliceEnd > pos && text.charCodeAt(sliceEnd - 1) === 13) sliceEnd -= 1;
      value += text.slice(pos, sliceEnd);
      if (ended === COMMA) {
        pos = end + 1;
      } else if (ended === LINE_BREAK) {
        pos = end + 1;
        line += 1;
      } else {
        pos = n;
      }
      fieldEnded = ended;
      fieldAdded = value.length - startLen;
      return value;
    }
  }

  // The quoted content in [a, b) with each CRLF or lone CR read as LF, and
  // `line` moved past every line break in it. Most quoted fields hold no
  // line break at all, so this stays a plain slice for them.
  function quotedSegment(a, b) {
    if (b <= a) return '';
    // Any line break in the segment at all?
    let i = text.indexOf('\n', a);
    const hasLf = i !== -1 && i < b;
    i = text.indexOf('\r', a);
    const hasCr = i !== -1 && i < b;
    if (!hasLf && !hasCr) return text.slice(a, b);
    let s = text.slice(a, b);
    let breaks = 0;
    for (let j = 0; j < s.length; j++) {
      const ch = s.charCodeAt(j);
      if (ch === 10) breaks++;
      else if (ch === 13) {
        breaks++;
        if (s.charCodeAt(j + 1) === 10) j++;
      }
    }
    line += breaks;
    if (hasCr) s = s.replace(/\r\n?/g, '\n');
    return s;
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field;
  // fieldEnded says how it ended (fieldAdded is 0 unless junk followed it).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let segStart = pos;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote inside the field.
        value += quotedSegment(segStart, q);
        value += '"';
        pos = q + 2;
        segStart = pos;
        continue;
      }
      // The closing quote.
      value += quotedSegment(segStart, q);
      pos = q + 1;
      break;
    }
    if (pos >= n) {
      fieldEnded = END;
      fieldAdded = 0;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fieldEnded = COMMA;
      fieldAdded = 0;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fieldEnded = LINE_BREAK;
      fieldAdded = 0;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fieldEnded = LINE_BREAK;
      fieldAdded = 0;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break. The quoted field may have crossed lines, so
    // the stray-CR flag must be the closing line's, not the record's first.
    refreshFlag();
    const out = readUnquoted(value);
    if (fieldAdded > 0) error('quote_junk');
    return out;
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

    // A clean line: no quote and no stray CR in it, so it is one record of
    // plain fields, split at once. The line ends at the next LF (or the end
    // of the text); a CR at its very end is that LF's CRLF half.
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? n : nl;
    QUOTE_OR_CR.lastIndex = pos;
    const cm = QUOTE_OR_CR.exec(text);
    let clean = false;
    if (cm === null || cm.index >= segEnd) clean = true;
    else if (cm.index === segEnd - 1 && nl !== -1 && text.charCodeAt(cm.index) === 13) clean = true;

    let fields;
    let quoted = false;
    if (clean) {
      let end = segEnd;
      if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) end -= 1;
      fields = text.slice(pos, end).split(',');
      line += 1;
      pos = nl === -1 ? n : nl + 1;
    } else {
      // The stray-CR flag for this line, for the field-by-field readers.
      flagLine = line;
      flagLineEnd = segEnd;
      lineHasCr = checkLineCr(pos, segEnd, nl !== -1);
      fields = [];
      let value;
      do {
        quoted = text.charCodeAt(pos) === 34;
        value = quoted ? readQuoted() : readUnquoted('');
        // A quoted field may have crossed lines: refresh the flag for the
        // line the next field starts on.
        refreshFlag();
        fields.push(value);
      } while (fieldEnded === COMMA);
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
