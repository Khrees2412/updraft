import { useRef, useState } from 'react';
import { filterFolder, formatSize, type FileEntry, type FilterResult } from '../lib/upload-filter';

declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}


export interface PickedFolder {
  name: string;
  result: FilterResult;
}

interface FolderPickerProps {
  picked: PickedFolder | null;
  onPicked: (folder: PickedFolder | null) => void;
  disabled?: boolean;
}

function stripTopFolder(path: string): { top: string; rest: string } {
  const normalized = path.startsWith('/') ? path.slice(1) : path;
  const slash = normalized.indexOf('/');
  if (slash === -1) return { top: normalized, rest: normalized };
  return { top: normalized.slice(0, slash), rest: normalized.slice(slash + 1) };
}

function entriesFromFileList(files: FileList): FileEntry[] {
  const result: FileEntry[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files.item(i);
    if (!file) continue;
    const raw = file.webkitRelativePath || file.name;
    const { rest } = stripTopFolder(raw);
    if (!rest) continue;
    result.push({ file, relativePath: rest });
  }
  return result;
}

async function readDirEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  const readBatch = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => {
      reader.readEntries((entries) => resolve(Array.from(entries)), reject);
    });
  let batch = await readBatch();
  while (batch.length > 0) {
    all.push(...batch);
    batch = await readBatch();
  }
  return all;
}

async function walkEntry(entry: FileSystemEntry, rootPath: string): Promise<FileEntry[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
    const rel = entry.fullPath.startsWith(rootPath)
      ? entry.fullPath.slice(rootPath.length).replace(/^\//, '')
      : entry.fullPath.replace(/^\//, '');
    return [{ file, relativePath: rel }];
  }
  const children = await readDirEntries(entry as FileSystemDirectoryEntry);
  const nested = await Promise.all(children.map((c) => walkEntry(c, rootPath)));
  return nested.flat();
}

function topName(entry: FileSystemEntry): string {
  const path = entry.fullPath.replace(/^\//, '');
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(0, slash);
}

export function FolderPicker({ picked, onPicked, disabled }: FolderPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setDragOver] = useState(false);
  const [isProcessing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (entries: FileEntry[], folderName: string) => {
    setProcessing(true);
    setError(null);
    try {
      const result = await filterFolder(entries);
      onPicked({ name: folderName, result });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read folder');
    } finally {
      setProcessing(false);
    }
  };

  const handleInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const first = files.item(0);
    const rawPath = first?.webkitRelativePath ?? '';
    const folderName = rawPath ? stripTopFolder(rawPath).top : 'project';
    const entries = entriesFromFileList(files);
    await handleFiles(entries, folderName);
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const items = event.dataTransfer.items;
    if (!items || items.length === 0) return;
    const fsEntries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const entry = item?.webkitGetAsEntry() ?? null;
      if (entry) fsEntries.push(entry);
    }
    if (fsEntries.length === 0) return;
    const root = fsEntries[0]!;
    if (root.isFile) {
      setError('Please drop a folder, not a file');
      return;
    }
    if (fsEntries.length > 1) {
      setError('Drop a single folder');
      return;
    }
    setProcessing(true);
    setError(null);
    try {
      const folderName = topName(root);
      const collected = await walkEntry(root, root.fullPath);
      await handleFiles(collected, folderName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read folder');
      setProcessing(false);
    }
  };

  const handleClear = () => {
    onPicked(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleClick = () => {
    if (disabled || isProcessing) return;
    inputRef.current?.click();
  };

  if (picked) {
    const { result, name } = picked;
    return (
      <div className="folder-summary">
        <div className="folder-summary-row">
          <div>
            <p className="folder-summary-name">{name}</p>
            <p className="folder-summary-stats">
              {result.kept.length} files · {formatSize(result.totalKeptSize)}
              {result.skippedCount > 0
                ? ` · ${result.skippedCount} skipped (${formatSize(result.skippedSize)})`
                : ''}
            </p>
          </div>
          <button type="button" className="link-button" onClick={handleClear} disabled={disabled}>
            Replace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`folder-drop-zone${isDragOver ? ' is-dragover' : ''}`}
      onClick={handleClick}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleClick()}
    >
      <input
        ref={inputRef}
        type="file"
        webkitdirectory=""
        directory=""
        multiple
        onChange={handleInput}
        style={{ display: 'none' }}
      />
      <p className="folder-drop-title">
        {isProcessing ? 'Reading folder...' : 'Drop a project folder here'}
      </p>
      <p className="folder-drop-hint">or click to choose · node_modules, .git, build outputs are skipped</p>
      {error ? <p className="form-message error">{error}</p> : null}
    </div>
  );
}
