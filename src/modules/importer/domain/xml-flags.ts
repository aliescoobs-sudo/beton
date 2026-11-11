/**
 * R17-05: a bounded XML tokenizer for ONE question: does the workbook declare the 1904 date system? A regular expression over the raw text
 * cannot be positive about that (a `>` inside a quoted attribute value ends its match early, which is how `<workbookPr codeName=">" date1904="1"/>`
 * once slipped through). This reads the part like XML does: comments, CDATA, processing instructions and end tags are skipped as units;
 * a start tag is read name, then attributes, each `name = "value"` or `name = 'value'` with the value running to its own closing quote
 * (a `>` is legal inside it, a `<` is not); entities and character references are decoded. It FAILS CLOSED: anything it cannot parse with
 * certainty (an unterminated construct, an unquoted or duplicated attribute, a `<` inside a value, an unknown entity, a DOCTYPE, a NUL, an
 * excessive size or tag count) throws an XmlFlagsError, so a file whose calendar cannot be determined is never read.
 *
 * Deliberately conservative about names: ANY prefix on the element (`x:workbookPr`) and on the attribute (`x:date1904`) counts, since a prefix
 * cannot be trusted to be bound to anything else; the set of refused files is a superset of the 1904 workbooks, never a subset.
 */
export const MAX_WORKBOOK_XML = 2 * 1024 * 1024;
const MAX_TAGS = 200_000;
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/;

/** Thrown for a part that cannot be read with certainty; the sheet reader turns it into its own error. */
export class XmlFlagsError extends Error {
  readonly reason: string;
  constructor(message: string, reason = '') {
    super(message);
    this.reason = reason;
  }
}

const fail = (why: string): never => {
  throw new XmlFlagsError(
    `the workbook's date system could not be determined (${why}); open it in Excel, make sure "Use 1904 date system" is unticked and save it again`,
    why,
  );
};

/** The five predefined entities and numeric references; anything else is refused (no DTD is read, so no other entity can be defined). */
export function decodeXmlValue(v: string): string {
  if (/&(?!(?:#x[0-9a-fA-F]+|#\d+|quot|apos|lt|gt|amp);)/.test(v)) fail('an unknown entity');
  return v.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|apos|lt|gt|amp);/g, (_m, e: string) => {
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      return fail('a bad character reference');
    return String.fromCodePoint(code);
  });
}

export interface StartTag {
  name: string;
  attrs: Map<string, string>;
  /** Nesting depth (0 = the root element). Filled in strict mode only. */
  depth: number;
}

/**
 * Every start tag of the document, in order. STRICT mode (R18-09) also verifies the structure: a non-empty part, exactly one root element,
 * every end tag matching the open start tag, nothing left open, and no text outside the root.
 */
function startTags(xml: string, strict = false): StartTag[] {
  if (xml.length > MAX_WORKBOOK_XML) fail('the part is too large');
  if (xml.includes('\u0000')) fail('a NUL character');
  if (strict && xml.replace(/^\uFEFF/, '').trim() === '') fail('an empty part');
  const tags: StartTag[] = [];
  const stack: string[] = [];
  let roots = 0;
  const textBetween = (from: number, to: number) => {
    if (
      strict &&
      stack.length === 0 &&
      xml
        .slice(from, to)
        .replace(/^\uFEFF/, '')
        .trim() !== ''
    )
      fail('text outside the root element');
  };
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      textBetween(i, n);
      break;
    }
    textBetween(i, lt);
    i = lt;
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end < 0) fail('an unterminated comment');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      if (end < 0) fail('an unterminated CDATA section');
      i = end + 3;
    } else if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      if (end < 0) fail('an unterminated processing instruction');
      i = end + 2;
    } else if (xml.startsWith('<!', i)) {
      fail('a DOCTYPE or declaration');
    } else if (xml.startsWith('</', i)) {
      const end = xml.indexOf('>', i + 2);
      if (end < 0) fail('an unterminated end tag');
      if (strict) {
        const closing = xml.slice(i + 2, end).trim();
        if (stack.length === 0 || stack.pop() !== closing)
          fail('an end tag that does not match its start tag');
      }
      i = end + 1;
    } else {
      if (tags.length >= MAX_TAGS) fail('too many elements');
      if (strict && stack.length === 0 && ++roots > 1) fail('more than one root element');
      i += 1;
      const name = NAME.exec(xml.slice(i, i + 256))?.[0];
      if (!name) return fail('a malformed element name');
      i += name.length;
      const attrs = new Map<string, string>();
      let selfClosed = false;
      for (;;) {
        const ws = /^[ \t\r\n]*/.exec(xml.slice(i, i + 64))?.[0].length ?? 0;
        i += ws;
        const c = xml[i];
        if (c === undefined) return fail('an unterminated start tag');
        if (c === '>') {
          i += 1;
          break;
        }
        if (c === '/') {
          if (xml[i + 1] !== '>') return fail('a malformed empty-element tag');
          i += 2;
          selfClosed = true;
          break;
        }
        if (ws === 0) return fail('attributes without a separator');
        const an = NAME.exec(xml.slice(i, i + 256))?.[0];
        if (!an) return fail('a malformed attribute name');
        i += an.length;
        i += /^[ \t\r\n]*/.exec(xml.slice(i, i + 64))?.[0].length ?? 0;
        if (xml[i] !== '=') return fail('an attribute without a value');
        i += 1;
        i += /^[ \t\r\n]*/.exec(xml.slice(i, i + 64))?.[0].length ?? 0;
        const q = xml[i];
        if (q !== '"' && q !== "'") return fail('an unquoted attribute value');
        const close = xml.indexOf(q, i + 1);
        if (close < 0) return fail('an unterminated attribute value');
        const raw = xml.slice(i + 1, close);
        if (raw.includes('<')) return fail('a "<" inside an attribute value');
        if (attrs.has(an)) return fail('a duplicated attribute');
        attrs.set(an, decodeXmlValue(raw));
        i = close + 1;
      }
      tags.push({ name, attrs, depth: stack.length });
      if (strict && !selfClosed) stack.push(name);
    }
  }
  if (strict) {
    if (stack.length > 0) fail('an element that is never closed');
    if (roots !== 1) fail('no root element');
  }
  return tags;
}

const local = (qname: string): string => qname.split(':').pop() ?? qname;

/**
 * True when the workbook declares any date system other than the default one (1900), false when it plainly does not. Throws an XmlFlagsError
 * for a workbook part it cannot read with certainty. An empty part (no workbook.xml) declares nothing.
 */
export function workbookUses1904(xml: string): boolean {
  let refused = false;
  for (const tag of startTags(xml)) {
    if (local(tag.name) !== 'workbookPr') continue;
    for (const [an, value] of tag.attrs) {
      if (local(an) !== 'date1904') continue;
      const v = value.trim().toLowerCase();
      if (v !== '0' && v !== 'false') refused = true;
    }
  }
  return refused;
}

/**
 * R18-09: the start tags of a part that must be a COMPLETE, well-formed document (one root, matching end tags, nothing open, no text outside
 * the root). An empty, truncated or mis-nested part throws an XmlFlagsError. Used for the package relationships and the workbook part, whose
 * content decides which calendar and which sheets are read.
 */
export function parseXmlDocument(xml: string): StartTag[] {
  return startTags(xml, true);
}

/** The local name of an element or attribute (the prefix removed). */
export const localName = local;
