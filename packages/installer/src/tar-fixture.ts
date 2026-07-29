/**
 * Test-only tar builder.
 *
 * Lives outside the test files because both the extraction and the install suites need it.
 * It writes ustar headers by hand specifically so it can emit entries a well-behaved archiver
 * would refuse to produce — traversing names, absolute paths, symlinks — which is exactly what
 * the extraction policy has to be tested against.
 */
import { gzipSync } from 'node:zlib';

export interface TarEntry {
  name: string;
  content?: string;
  /** ustar typeflag: '0' file, '5' directory, '2' symlink, '1' hardlink. */
  type?: '0' | '5' | '2' | '1';
  linkname?: string;
}

export function makeTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '', 'utf8');
    const type = entry.type ?? '0';
    const size = type === '0' ? content.length : 0;
    const header = Buffer.alloc(512, 0);

    header.write(entry.name.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100, 'ascii'); // mode
    header.write('0000000\0', 108, 'ascii'); // uid
    header.write('0000000\0', 116, 'ascii'); // gid
    header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii'); // mtime
    header.write('        ', 148, 'ascii'); // checksum placeholder: spaces
    header.write(type, 156, 'ascii');
    if (entry.linkname) header.write(entry.linkname.slice(0, 100), 157, 'utf8');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');

    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');

    blocks.push(header);
    if (size > 0) {
      const padded = Buffer.alloc(Math.ceil(size / 512) * 512, 0);
      content.copy(padded);
      blocks.push(padded);
    }
  }

  blocks.push(Buffer.alloc(1024, 0)); // two empty blocks terminate the archive
  return gzipSync(Buffer.concat(blocks));
}

/** A minimal, valid module in the shape GitHub actually produces. */
export function makeModuleArchive(
  manifest: Record<string, unknown>,
  files: Record<string, string> = { 'src/index.ts': 'export default {};' },
  topLevel = 'my-module-abc123',
): Buffer {
  const entries: TarEntry[] = [
    { name: `${topLevel}/`, type: '5' },
    { name: `${topLevel}/module.json`, content: JSON.stringify(manifest, null, 2) },
  ];

  for (const [path, content] of Object.entries(files)) {
    entries.push({ name: `${topLevel}/${path}`, content });
  }

  return makeTar(entries);
}
