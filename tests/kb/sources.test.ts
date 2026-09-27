import { describe, expect, it } from 'vitest';
import {
  SOURCE_FILES_LIMIT,
  decodeSourceFiles,
  encodeSourceFiles,
  extractSourceFiles,
} from '../../src/kb/sources.js';

describe('extractSourceFiles', () => {
  it('reads the references a page is written with, line numbers included in the token', () => {
    const body = [
      '# Car API',
      '',
      'The controller lives in scripts/Car.cs:262-272 and the bar in scripts/Hud.cs:43.',
      'Calibration is run by tools/carcalib.bat; see also docs/notes.md.',
    ].join('\n');

    expect(extractSourceFiles(body)).toEqual([
      'scripts/Car.cs',
      'scripts/Hud.cs',
      'tools/carcalib.bat',
      'docs/notes.md',
    ]);
  });

  it('takes a bare filename when its extension is one a project holds', () => {
    expect(extractSourceFiles('Edit project.godot and Car.cs, then run dev.bat.')).toEqual([
      'project.godot',
      'Car.cs',
      'dev.bat',
    ]);
  });

  it('leaves out the tokens that only look like paths', () => {
    const body = [
      'Godot 4.7.2 with version 1.2.3 of the plugin, e.g. see https://host/path/file.md.',
      'Nothing here is a file: 3.5 seconds, node_modules, a sentence ends.',
    ].join('\n');

    // A version number has no known extension and no directory; a URL is another project's
    // file, and anchoring a page to it would report changes that are not this project's.
    expect(extractSourceFiles(body)).toEqual([]);
  });

  it('normalizes Windows separators, because git reports forward slashes', () => {
    expect(extractSourceFiles('see scripts\\Car.cs and .\\tools\\check.ps1')).toEqual([
      'scripts/Car.cs',
      'tools/check.ps1',
    ]);
  });

  it('keeps the dot a hidden path opens with, because it is part of the name git reports', () => {
    const body = [
      'The host rewrites .qwen/settings.json and the state lives in .state3/state.db.',
      'A workflow is .github/workflows/ci.yml; the root holds .gitignore and .env.',
    ].join('\n');

    // Read as the punctuation of the sentence in front, the dot left the anchor naming
    // qwen/settings.json — a path git never reports, so the page could not go stale however
    // the file moved, and coverage kept listing a file a page does name.
    expect(extractSourceFiles(body)).toEqual([
      '.qwen/settings.json',
      '.state3/state.db',
      '.github/workflows/ci.yml',
      '.gitignore',
      '.env',
    ]);
  });

  it('still leaves out a hidden directory, which is not a file to anchor to', () => {
    expect(extractSourceFiles('state lives in .state3 and dist, not in .github alone')).toEqual([]);
  });

  it('takes a bare extension in prose for a path, the cheaper of the two mistakes', () => {
    // "The newest .js in dist" anchors to a path that does not exist. It is inert — git never
    // reports it, so neither staleness nor coverage can see it — and the alternative is
    // missing .gitignore and .env, which SOURCE_EXTENSIONS holds extensions for and which a
    // page must be able to anchor to.
    expect(extractSourceFiles('the newest .js in dist, not the .gitignore')).toEqual([
      '.js',
      '.gitignore',
    ]);
  });

  it('still reads as punctuation a dot that ends a sentence or quotes "here"', () => {
    expect(extractSourceFiles('run .\\tools\\check.ps1, then see ... src/kb/sources.ts.')).toEqual([
      'tools/check.ps1',
      'src/kb/sources.ts',
    ]);
  });

  it('names a file once however often the page mentions it', () => {
    expect(extractSourceFiles('scripts/Car.cs, then scripts/Car.cs:12 again')).toEqual([
      'scripts/Car.cs',
    ]);
  });

  it('stops at the limit, since a longer list is a file dump and not a page', () => {
    const body = Array.from({ length: SOURCE_FILES_LIMIT + 20 }, (_, i) => `src/f${i}.ts`).join(
      '\n',
    );

    expect(extractSourceFiles(body)).toHaveLength(SOURCE_FILES_LIMIT);
  });

  it('reads an empty body as no anchor at all', () => {
    expect(extractSourceFiles('')).toEqual([]);
    expect(extractSourceFiles('A page about decisions and intent.')).toEqual([]);
  });
});

describe('the stored form', () => {
  it('round-trips, and an empty column reads as no anchor', () => {
    const files = ['scripts/Car.cs', 'tools/carcalib.bat'];
    expect(decodeSourceFiles(encodeSourceFiles(files))).toEqual(files);
    expect(decodeSourceFiles('')).toEqual([]);
    expect(decodeSourceFiles(null)).toEqual([]);
  });
});
