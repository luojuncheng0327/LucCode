"use strict";

/**
 * shared/artifact-core/ustar.cjs
 *
 * Minimal ustar tar reader/writer for signed runtime artifacts.
 *
 * We control the producer (packTree), so the consumer (extract) can be
 * strict by construction: only plain files and directories are accepted.
 * Symlinks, hardlinks, absolute paths, and `..` traversal are rejected
 * outright before any filesystem write happens for that entry — this IS
 * the path-traversal defense, not a bolt-on check.
 *
 * Pure Node built-ins (fs, path, zlib, crypto). Loadable via `require()`
 * from both Electron main (CJS) and plain Node scripts/tests.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");

const BLOCK_SIZE = 512;

const TYPEFLAG_REGULAR_A = "0";
const TYPEFLAG_REGULAR_B = "\0";
const TYPEFLAG_DIRECTORY = "5";
const TYPEFLAG_HARDLINK = "1";
const TYPEFLAG_SYMLINK = "2";

const MODE_EXECUTABLE = 0o755;
const MODE_REGULAR = 0o644;
const MODE_DIRECTORY = 0o755;

// ---- header field layout (POSIX ustar, 512-byte block) ---------------

const FIELD = {
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  mtime: [136, 12],
  chksum: [148, 8],
  typeflag: [156, 1],
  linkname: [157, 100],
  magic: [257, 6],
  version: [263, 2],
  uname: [265, 32],
  gname: [297, 32],
  devmajor: [329, 8],
  devminor: [337, 8],
  prefix: [345, 155],
};

// ---- path safety -------------------------------------------------------

/**
 * Rejects absolute paths, backslash-separated paths (packTree never emits
 * these; their presence is a sign of a hostile archive), empty paths, and
 * any path containing a `..` segment. This is the sole gate standing
 * between an extracted archive and the host filesystem, so it fails
 * closed on anything it does not recognize as safe.
 * @param {string} relPath
 */
function assertSafeRelativePath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("ustar: empty entry path");
  }
  if (relPath.includes("\\")) {
    throw new Error(`ustar: backslash not allowed in entry path: ${relPath}`);
  }
  if (relPath.startsWith("/")) {
    throw new Error(`ustar: absolute path not allowed: ${relPath}`);
  }
  if (/^[A-Za-z]:/.test(relPath)) {
    throw new Error(`ustar: drive-letter path not allowed: ${relPath}`);
  }
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(`ustar: path traversal segment '..' not allowed: ${relPath}`);
    }
  }
}

/**
 * @param {string} typeflag
 * @param {string} fullPath
 * @returns {"file"|"directory"}
 */
function assertAcceptedTypeflag(typeflag, fullPath) {
  if (typeflag === TYPEFLAG_REGULAR_A || typeflag === TYPEFLAG_REGULAR_B) return "file";
  if (typeflag === TYPEFLAG_DIRECTORY) return "directory";
  if (typeflag === TYPEFLAG_SYMLINK) {
    throw new Error(`ustar: symlink entries are not allowed: ${fullPath}`);
  }
  if (typeflag === TYPEFLAG_HARDLINK) {
    throw new Error(`ustar: hardlink entries are not allowed: ${fullPath}`);
  }
  throw new Error(`ustar: unknown typeflag ${JSON.stringify(typeflag)} for entry: ${fullPath}`);
}

// ---- low-level field encode/decode -------------------------------------

function octalField(value, fieldLen) {
  const str = Math.floor(value).toString(8);
  if (str.length > fieldLen - 1) {
    throw new Error(`ustar: numeric field overflow (${value}) for length ${fieldLen}`);
  }
  return str.padStart(fieldLen - 1, "0") + "\0";
}

function readOctalField(buf, offset, len) {
  const raw = buf.toString("latin1", offset, offset + len);
  const trimmed = raw.replace(/\0/g, "").trim();
  if (trimmed.length === 0) return 0;
  const value = parseInt(trimmed, 8);
  if (Number.isNaN(value)) {
    throw new Error(`ustar: malformed numeric header field: ${JSON.stringify(raw)}`);
  }
  return value;
}

function writeStringField(buf, offset, len, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > len) {
    throw new Error(`ustar: string field overflow: ${value}`);
  }
  encoded.copy(buf, offset);
}

function readStringField(buf, offset, len) {
  const raw = buf.subarray(offset, offset + len);
  const nullIdx = raw.indexOf(0);
  const bytes = nullIdx === -1 ? raw : raw.subarray(0, nullIdx);
  return bytes.toString("utf8");
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/**
 * Splits a relative path into ustar's prefix/name pair when it exceeds the
 * 100-byte name field (node_modules trees routinely do). Any valid split
 * point works — we keep the last one found (longest prefix that still
 * satisfies both length limits).
 * @param {string} name
 */
function splitPath(name) {
  const nameBytes = Buffer.byteLength(name, "utf8");
  if (nameBytes <= 100) return { prefix: "", name };
  if (nameBytes > 255) {
    throw new Error(`ustar: path too long for ustar format (max 255 bytes): ${name}`);
  }
  let splitIdx = -1;
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const suffix = name.slice(i + 1);
    if (Buffer.byteLength(suffix, "utf8") <= 100 && Buffer.byteLength(prefix, "utf8") <= 155) {
      splitIdx = i;
    }
  }
  if (splitIdx === -1) {
    throw new Error(`ustar: path cannot be split to fit the ustar prefix/name fields: ${name}`);
  }
  return { prefix: name.slice(0, splitIdx), name: name.slice(splitIdx + 1) };
}

function buildHeaderBlock({ fullPath, typeflag, size, mode, mtimeSec }) {
  const block = Buffer.alloc(BLOCK_SIZE, 0);
  const isDir = typeflag === TYPEFLAG_DIRECTORY;
  const nameForHeader = isDir && !fullPath.endsWith("/") ? `${fullPath}/` : fullPath;
  const { prefix, name } = splitPath(nameForHeader);

  writeStringField(block, FIELD.name[0], FIELD.name[1], name);
  block.write(octalField(mode, FIELD.mode[1]), FIELD.mode[0], "latin1");
  block.write(octalField(0, FIELD.uid[1]), FIELD.uid[0], "latin1");
  block.write(octalField(0, FIELD.gid[1]), FIELD.gid[0], "latin1");
  block.write(octalField(size, FIELD.size[1]), FIELD.size[0], "latin1");
  block.write(octalField(mtimeSec, FIELD.mtime[1]), FIELD.mtime[0], "latin1");
  block.write("        ", FIELD.chksum[0], "latin1"); // 8 spaces placeholder during checksum calc
  block.write(typeflag, FIELD.typeflag[0], "latin1");
  writeStringField(block, FIELD.linkname[0], FIELD.linkname[1], "");
  writeStringField(block, FIELD.magic[0], FIELD.magic[1], "ustar\0");
  block.write("00", FIELD.version[0], "latin1");
  writeStringField(block, FIELD.uname[0], FIELD.uname[1], "");
  writeStringField(block, FIELD.gname[0], FIELD.gname[1], "");
  block.write(octalField(0, FIELD.devmajor[1]), FIELD.devmajor[0], "latin1");
  block.write(octalField(0, FIELD.devminor[1]), FIELD.devminor[0], "latin1");
  writeStringField(block, FIELD.prefix[0], FIELD.prefix[1], prefix);

  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) checksum += block[i];
  const chksumStr = checksum.toString(8).padStart(6, "0") + "\0 ";
  block.write(chksumStr, FIELD.chksum[0], "latin1");
  return block;
}

function parseHeaderBlock(block) {
  const magic = readStringField(block, FIELD.magic[0], FIELD.magic[1]);
  if (magic !== "ustar") {
    throw new Error(`ustar: bad magic bytes, not a ustar archive (got ${JSON.stringify(magic)})`);
  }

  const storedChecksum = readOctalField(block, FIELD.chksum[0], FIELD.chksum[1]);
  const check = Buffer.from(block);
  check.fill(0x20, FIELD.chksum[0], FIELD.chksum[0] + FIELD.chksum[1]);
  let computed = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) computed += check[i];
  if (computed !== storedChecksum) {
    throw new Error("ustar: header checksum mismatch (corrupt archive)");
  }

  const name = readStringField(block, FIELD.name[0], FIELD.name[1]);
  const prefix = readStringField(block, FIELD.prefix[0], FIELD.prefix[1]);
  const fullPath = prefix ? `${prefix}/${name}` : name;
  const mode = readOctalField(block, FIELD.mode[0], FIELD.mode[1]);
  const size = readOctalField(block, FIELD.size[0], FIELD.size[1]);
  const mtime = readOctalField(block, FIELD.mtime[0], FIELD.mtime[1]);
  const typeflag = block.toString("latin1", FIELD.typeflag[0], FIELD.typeflag[0] + 1);

  return { fullPath, mode, size, mtime, typeflag };
}

// ---- extract (streaming gunzip -> block parser) -------------------------

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

function closeFile(stream) {
  return new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Streams a ustar `.tar.gz` archive into `destDir`. Rejects (and stops
 * before writing anything for the offending entry) on symlinks, hardlinks,
 * absolute paths, `..` traversal, and unknown typeflags. Preserves only
 * the executable bit (files land as 0o755 or 0o644; directories as
 * 0o755).
 * @param {string} archivePath
 * @param {string} destDir
 * @returns {Promise<void>}
 */
async function extract(archivePath, destDir) {
  const resolvedDest = path.resolve(destDir);
  await fsp.mkdir(resolvedDest, { recursive: true });

  const source = fs.createReadStream(archivePath).pipe(zlib.createGunzip());

  let buf = Buffer.alloc(0);
  /** @type {{ out: import('fs').WriteStream, remainingData: number, remainingPad: number, path: string } | null} */
  let fileState = null;

  async function flushBuffered() {
    let offset = 0;
    for (;;) {
      if (fileState) {
        const avail = buf.length - offset;
        if (avail === 0) break;
        if (fileState.remainingData > 0) {
          const take = Math.min(avail, fileState.remainingData);
          await writeChunk(fileState.out, buf.subarray(offset, offset + take));
          fileState.remainingData -= take;
          offset += take;
          continue;
        }
        if (fileState.remainingPad > 0) {
          const take = Math.min(buf.length - offset, fileState.remainingPad);
          fileState.remainingPad -= take;
          offset += take;
          if (fileState.remainingPad > 0) break;
        }
        await closeFile(fileState.out);
        fileState = null;
        continue;
      }

      if (buf.length - offset < BLOCK_SIZE) break;
      const block = buf.subarray(offset, offset + BLOCK_SIZE);
      offset += BLOCK_SIZE;

      if (isZeroBlock(block)) {
        continue; // end-of-archive terminator block(s); keep draining, ignore
      }

      const header = parseHeaderBlock(block);
      const cleanPath = header.fullPath.replace(/\/+$/, "");
      assertSafeRelativePath(cleanPath);
      const kind = assertAcceptedTypeflag(header.typeflag, header.fullPath);
      const destPath = path.join(resolvedDest, cleanPath);

      if (kind === "directory") {
        await fsp.mkdir(destPath, { recursive: true });
        await fsp.chmod(destPath, MODE_DIRECTORY);
      } else {
        await fsp.mkdir(path.dirname(destPath), { recursive: true });
        const isExecutable = (header.mode & 0o111) !== 0;
        const out = fs.createWriteStream(destPath, {
          mode: isExecutable ? MODE_EXECUTABLE : MODE_REGULAR,
        });
        const pad = header.size % BLOCK_SIZE === 0 ? 0 : BLOCK_SIZE - (header.size % BLOCK_SIZE);
        fileState = { out, remainingData: header.size, remainingPad: pad, path: destPath };
        if (header.size === 0) {
          await closeFile(out);
          fileState = null;
        }
      }
    }
    return buf.subarray(offset);
  }

  for await (const chunk of source) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    buf = await flushBuffered();
  }
  buf = await flushBuffered();

  if (fileState) {
    throw new Error(`ustar: truncated archive, unexpected end of stream while reading ${fileState.path}`);
  }
  for (const byte of buf) {
    if (byte !== 0) {
      throw new Error("ustar: trailing garbage after archive terminator");
    }
  }
}

// ---- packTree (deterministic producer) ----------------------------------

/**
 * Packs `srcDir` into a ustar `.tar.gz` archive at `archivePath`, walking
 * entries in deterministic (sorted) order so archives are reproducible.
 * Refuses to pack symlinks (the extractor would refuse to read them back
 * anyway — fail at production time, not consumption time).
 * @param {string} srcDir
 * @param {string} archivePath
 * @returns {Promise<void>}
 */
async function packTree(srcDir, archivePath) {
  const resolvedSrc = path.resolve(srcDir);
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });

  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(archivePath);
  const done = new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    gzip.on("error", reject);
  });
  gzip.pipe(out);

  async function writeBlock(block) {
    if (!gzip.write(block)) {
      await new Promise((resolve) => gzip.once("drain", resolve));
    }
  }

  async function walk(relDir) {
    const absDir = path.join(resolvedSrc, relDir);
    const entries = await fsp.readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = path.join(resolvedSrc, relPath);
      const stat = await fsp.lstat(absPath);

      if (stat.isSymbolicLink()) {
        throw new Error(`packTree: refusing to pack symlink: ${relPath}`);
      }
      if (stat.isDirectory()) {
        await writeBlock(
          buildHeaderBlock({
            fullPath: relPath,
            typeflag: TYPEFLAG_DIRECTORY,
            size: 0,
            mode: MODE_DIRECTORY,
            mtimeSec: Math.floor(stat.mtimeMs / 1000),
          }),
        );
        await walk(relPath);
      } else if (stat.isFile()) {
        const isExecutable = (stat.mode & 0o111) !== 0;
        const mode = isExecutable ? MODE_EXECUTABLE : MODE_REGULAR;
        await writeBlock(
          buildHeaderBlock({
            fullPath: relPath,
            typeflag: TYPEFLAG_REGULAR_A,
            size: stat.size,
            mode,
            mtimeSec: Math.floor(stat.mtimeMs / 1000),
          }),
        );
        const fileStream = fs.createReadStream(absPath);
        let written = 0;
        for await (const chunk of fileStream) {
          written += chunk.length;
          await writeBlock(chunk);
        }
        if (written !== stat.size) {
          throw new Error(`packTree: size changed while packing ${relPath} (expected ${stat.size}, wrote ${written})`);
        }
        const pad = written % BLOCK_SIZE === 0 ? 0 : BLOCK_SIZE - (written % BLOCK_SIZE);
        if (pad > 0) await writeBlock(Buffer.alloc(pad, 0));
      } else {
        throw new Error(`packTree: unsupported file type for entry: ${relPath}`);
      }
    }
  }

  await walk("");
  await writeBlock(Buffer.alloc(BLOCK_SIZE * 2, 0)); // end-of-archive terminator
  gzip.end();
  await done;
}

module.exports = {
  BLOCK_SIZE,
  extract,
  packTree,
  assertSafeRelativePath,
};
