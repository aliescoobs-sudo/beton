import { inflateSync } from 'node:zlib';

/**
 * The text of a PDF made by `PdfDocument` (hex strings in deflated content streams), one string per page, and a check that the
 * file is well formed: header, the cross-reference table pointing at every object, the trailer. Used by the tests of every
 * document, so that "the BL PDF has no price" is checked on the bytes that leave the server.
 */
export function readPdf(bytes: Uint8Array): { pages: string[]; objects: number } {
  const buf = Buffer.from(bytes);
  const text = buf.toString('latin1');
  if (!text.startsWith('%PDF-1.4')) throw new Error('not a PDF');
  if (!text.trimEnd().endsWith('%%EOF')) throw new Error('no end marker');
  const start = Number(/startxref\n(\d+)\n%%EOF\s*$/.exec(text)?.[1]);
  if (!Number.isFinite(start) || text.slice(start, start + 4) !== 'xref')
    throw new Error('startxref does not point at the table');
  const size = Number(/trailer\n<< \/Size (\d+)/.exec(text)?.[1]);
  const entries = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  if (entries.length !== size - 1) throw new Error('the table does not list every object');
  entries.forEach((offset, i) => {
    if (!text.startsWith(`${i + 1} 0 obj\n`, offset))
      throw new Error(`object ${i + 1} is not where the table says`);
  });
  const pages: string[] = [];
  for (const m of text.matchAll(/\/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)) {
    const from = (m.index ?? 0) + m[0].length;
    const content = inflateSync(buf.subarray(from, from + Number(m[1]))).toString('latin1');
    const strings = [...content.matchAll(/<([0-9a-f]+)> Tj/g)].map((t) =>
      Buffer.from(t[1] as string, 'hex').toString('latin1'),
    );
    pages.push(strings.join('\n'));
  }
  return { pages, objects: entries.length };
}
