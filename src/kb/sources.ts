/**
 * The files a page body names.
 *
 * A knowledge base is told to point at the code instead of copying it, so a page body is
 * full of references like `scripts/Car.cs:262-272`. Those references are what makes a page
 * go stale, and until they were extracted nothing could tell a reader that the file had
 * moved on: the page kept its `current` status while describing code from a week ago.
 *
 * Extraction is deliberately conservative. A false positive costs one line in a report; a
 * false negative hides a page that should have been checked. So a token counts as a file
 * only when it ends in an extension this module knows, or when it carries a directory
 * separator — which leaves version numbers, domain names and ordinary sentences out.
 */

/** Extensions that make a token a file reference on their own, without a directory in front. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  'bat',
  'c',
  'cfg',
  'cpp',
  'cs',
  'csproj',
  'css',
  'env',
  'gd',
  'gdshader',
  'gitignore',
  'godot',
  'go',
  'h',
  'hpp',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'lock',
  'lua',
  'md',
  'mjs',
  'php',
  'png',
  'props',
  'ps1',
  'py',
  'rb',
  'resx',
  'rs',
  'scss',
  'sh',
  'sln',
  'sql',
  'svg',
  'targets',
  'toml',
  'tres',
  'tscn',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
];

/**
 * How many files one page is anchored to. A page naming more than this is a file listing
 * rather than a document, and asking git about hundreds of paths on every read would cost
 * more than the anchor is worth.
 */
export const SOURCE_FILES_LIMIT = 50;

/** A token that looks like `path/to/file.ext`, optionally followed by `:line` or `:from-to`. */
const FILE_REFERENCE = /[A-Za-z0-9_.\\/-]+\.[A-Za-z0-9]{1,10}(?::\d+(?:-\d+)?)?/g;

/** Anything a URL is made of, so `https://host/path/file.md` is not read as a project file. */
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** Punctuation a reference picks up from the sentence around it. */
const TRAILING_JUNK = /[.,;:!?()[\]{}<>"'`*]+$/;
const LEADING_JUNK = /^[.,;:!?()[\]{}<>"'`*]+/;

const KNOWN_EXTENSIONS = new Set(SOURCE_EXTENSIONS);

/**
 * The project files a body refers to, in the order they first appear, without duplicates.
 *
 * Line references are dropped: the anchor is the file, since a line number is exactly what
 * stops being true. Separators are normalized to `/`, which is what git reports, so a
 * reference written with Windows separators still matches the paths git returns.
 */
export function extractSourceFiles(body: string): string[] {
  if (body === '') return [];

  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of body.replace(URL, ' ').matchAll(FILE_REFERENCE)) {
    const path = normalize(match[0]);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    found.push(path);
    if (found.length >= SOURCE_FILES_LIMIT) break;
  }
  return found;
}

/** One candidate token as a project-relative path, or null when it is not a file reference. */
function normalize(token: string): string | null {
  // The line reference is part of the token but not of the path.
  const withoutLines = token.replace(/:\d+(?:-\d+)?$/, '');
  const cleaned = withoutLines.replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '');
  const path = cleaned.replace(/\\/g, '/');
  if (path === '') return null;

  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  // No dot in the last segment means no extension, and a directory is not a file to anchor
  // to: git reports the files under it, not the folder.
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const hasDirectory = slash >= 0;
  if (!hasDirectory && !KNOWN_EXTENSIONS.has(extension)) return null;
  // A leading "./" or "/" is how a body quotes a path, not how git names it.
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** The stored form: one path per line. Newlines cannot appear in a path, so nothing escapes. */
export function encodeSourceFiles(files: readonly string[]): string {
  return files.join('\n');
}

/** The paths of a stored page row; an empty column reads as no anchor. */
export function decodeSourceFiles(stored: string | null): string[] {
  if (stored === null || stored === '') return [];
  return stored.split('\n').filter((path) => path !== '');
}
