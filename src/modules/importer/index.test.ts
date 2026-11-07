import { describe, expect, it } from 'vitest';
import * as importer from './index';

// Extra 2: the module's public surface offers ONE way to write a workbook (importWorkbook, with its mode, marker and step-up checks).
// The row writer `runImport` and the legacy formatter that printed row labels stay inside the module.
describe('the importer surface is not an alternative import path', () => {
  it('does not export the low-level row writer or the label-printing formatter', () => {
    expect('runImport' in importer).toBe(false);
    expect('formatReport' in importer).toBe(false);
    expect(typeof importer.importWorkbook).toBe('function');
    expect(typeof importer.rollbackImport).toBe('function');
  });
});
