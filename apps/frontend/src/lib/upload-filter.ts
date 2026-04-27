import ignore, { type Ignore } from 'ignore';

const BASELINE_PATTERNS: readonly string[] = [
  // Version control — exclude .git itself but keep .gitignore so loadGitignore() can read it
  '.git',
  // Dependencies — match at any depth so monorepo node_modules are also excluded
  'node_modules',
  // Framework build caches — root-level only (leading slash) to avoid
  // stripping legitimate source folders like src/build/ or lib/dist/
  '/.next',
  '/.nuxt',
  '/.svelte-kit',
  '/.vercel',
  '/.netlify',
  '/.turbo',
  '/.cache',
  '/dist',
  '/build',
  '/out',
  '/coverage',
  // Secrets / local config — never upload these
  '.env',
  '.env.*',
  // OS junk
  '.DS_Store',
  'Thumbs.db',
  // Log files
  '*.log',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
  '.pnpm-debug.log*',
];

export interface FileEntry {
  file: File;
  relativePath: string;
}

export interface FilterResult {
  kept: FileEntry[];
  skippedCount: number;
  skippedSize: number;
  totalKeptSize: number;
}

export async function loadGitignore(entries: FileEntry[]): Promise<string | null> {
  const match = entries.find((e) => e.relativePath === '.gitignore');
  if (!match) return null;
  return match.file.text();
}

export function buildMatcher(gitignoreText: string | null): Ignore {
  const ig = ignore().add(BASELINE_PATTERNS as string[]);
  if (gitignoreText) ig.add(gitignoreText);
  return ig;
}

export function filterEntries(entries: FileEntry[], matcher: Ignore): FilterResult {
  const kept: FileEntry[] = [];
  let skippedCount = 0;
  let skippedSize = 0;
  let totalKeptSize = 0;
  for (const entry of entries) {
    if (matcher.ignores(entry.relativePath)) {
      skippedCount += 1;
      skippedSize += entry.file.size;
      continue;
    }
    kept.push(entry);
    totalKeptSize += entry.file.size;
  }
  return { kept, skippedCount, skippedSize, totalKeptSize };
}

export async function filterFolder(entries: FileEntry[]): Promise<FilterResult> {
  const gitignore = await loadGitignore(entries);
  const matcher = buildMatcher(gitignore);
  return filterEntries(entries, matcher);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
