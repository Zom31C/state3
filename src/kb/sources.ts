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

/**
 * The stored form of a list of lines: one per line, and nothing to escape.
 *
 * A page's file anchors and its symbol list are both stored this way, and neither can hold a
 * newline — a path has none, and a symbol line that wrapped would be two symbols.
 */
export function encodeLines(lines: readonly string[]): string {
  return lines.join('\n');
}

/** The lines of a stored list; an empty column reads as no entries. */
export function decodeLines(stored: string | null): string[] {
  if (stored === null || stored === '') return [];
  return stored.split('\n').filter((line) => line !== '');
}

/** The stored form of a page's file anchors: one path per line. */
export function encodeSourceFiles(files: readonly string[]): string {
  return encodeLines(files);
}

/**
 * The file a symbol line points at, or null when it names none.
 *
 * A symbol is written `Name — path/to/file.ext`, and the path half is what makes the field
 * worth keeping: it answers "where is this", which the name alone does not. Read through the
 * same extractor a body goes through, so a symbol line and a sentence in prose agree about
 * what counts as a file.
 */
export function symbolFile(symbol: string): string | null {
  return extractSourceFiles(symbol)[0] ?? null;
}

/**
 * Files no page is expected to document: a lock tool rewrites them wholesale, so a page
 * describing one would be wrong the next time a dependency moved, and "unchurned" is not a
 * property they have.
 */
const GENERATED_FILE_NAMES: ReadonlySet<string> = new Set([
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'yarn.lock',
]);

/**
 * True for a tracked path a page could be expected to name.
 *
 * The same rule `normalize` uses to decide that a token in a body IS a file — a known
 * extension, or a directory in front of it — because a file a page cannot anchor to is a
 * file the coverage report could never see covered, and listing one would ask for work that
 * cannot be recorded.
 */
export function isDocumentableFile(path: string): boolean {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  if (GENERATED_FILE_NAMES.has(name)) return false;
  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  return KNOWN_EXTENSIONS.has(extension) || slash >= 0;
}

/** The paths of a stored page row; an empty column reads as no anchor. */
export function decodeSourceFiles(stored: string | null): string[] {
  return decodeLines(stored);
}
