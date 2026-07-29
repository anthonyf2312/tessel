/**
 * Archive entry names come from a stranger's repository. Every one of them is joined onto a
 * directory on the host, so this is the function standing between a crafted tarball and a
 * write outside the extraction root.
 */
import { describe, expect, test } from 'vitest';
import { resolveEntryPath } from './paths.ts';

const ROOT = process.platform === 'win32' ? 'C:\\tessel\\extract' : '/tessel/extract';

describe('safe entries', () => {
  test('accepts a nested file', () => {
    expect(resolveEntryPath(ROOT, 'src/index.ts')).not.toBeNull();
  });

  test('accepts a file at the root', () => {
    expect(resolveEntryPath(ROOT, 'module.json')).not.toBeNull();
  });

  test('accepts a path containing a dot segment that stays inside', () => {
    expect(resolveEntryPath(ROOT, 'src/./index.ts')).not.toBeNull();
  });

  test('resolves inside the root', () => {
    const resolved = resolveEntryPath(ROOT, 'src/index.ts');

    expect(resolved?.startsWith(ROOT)).toBe(true);
  });
});

describe('traversal', () => {
  test('rejects a leading parent segment', () => {
    expect(resolveEntryPath(ROOT, '../evil.txt')).toBeNull();
  });

  test('rejects a parent segment in the middle', () => {
    expect(resolveEntryPath(ROOT, 'src/../../evil.txt')).toBeNull();
  });

  test('rejects backslash traversal', () => {
    expect(resolveEntryPath(ROOT, 'src\\..\\..\\evil.txt')).toBeNull();
  });

  test('rejects a deep climb', () => {
    expect(resolveEntryPath(ROOT, '../../../../../../etc/passwd')).toBeNull();
  });
});

describe('absolute paths', () => {
  test('rejects a POSIX absolute path', () => {
    expect(resolveEntryPath(ROOT, '/etc/passwd')).toBeNull();
  });

  test('rejects a Windows drive path', () => {
    expect(resolveEntryPath(ROOT, 'C:\\Windows\\System32\\config\\SAM')).toBeNull();
  });

  test('rejects a UNC path', () => {
    expect(resolveEntryPath(ROOT, '\\\\server\\share\\evil.txt')).toBeNull();
  });
});

describe('malformed names', () => {
  test('rejects an empty name', () => {
    expect(resolveEntryPath(ROOT, '')).toBeNull();
  });

  test('rejects a name containing a null byte', () => {
    expect(resolveEntryPath(ROOT, 'src/index.ts\u0000.png')).toBeNull();
  });
});
