// Minimal streaming ZIP writer (store method, no compression) — zero deps
const { Readable } = require('stream');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function localHeader(nameBuf, crc, size, time, date) {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);   // version needed
  b.writeUInt16LE(0, 6);    // flags
  b.writeUInt16LE(0, 8);    // method: store
  b.writeUInt16LE(time, 10);
  b.writeUInt16LE(date, 12);
  b.writeUInt32LE(crc, 14);
  b.writeUInt32LE(size, 18); // compressed
  b.writeUInt32LE(size, 22); // uncompressed
  b.writeUInt16LE(nameBuf.length, 26);
  b.writeUInt16LE(0, 28);   // extra len
  return b;
}

function centralHeader(nameBuf, crc, size, time, date, offset) {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);   // version made by
  b.writeUInt16LE(20, 6);   // version needed
  b.writeUInt16LE(0, 8);    // flags
  b.writeUInt16LE(0, 10);   // method
  b.writeUInt16LE(time, 12);
  b.writeUInt16LE(date, 14);
  b.writeUInt32LE(crc, 16);
  b.writeUInt32LE(size, 20);
  b.writeUInt32LE(size, 24);
  b.writeUInt16LE(nameBuf.length, 28);
  b.writeUInt16LE(0, 30);   // extra
  b.writeUInt16LE(0, 32);   // comment
  b.writeUInt16LE(0, 34);   // disk
  b.writeUInt16LE(0, 36);   // internal attrs
  b.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs
  b.writeUInt32LE(offset, 42);
  return b;
}

function endCentral(count, cdSize, cdOffset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize, 12);
  b.writeUInt32LE(cdOffset, 16);
  b.writeUInt16LE(0, 20);
  return b;
}

// entries: [{ name, filepath, mtime }] — streams a zip of file contents
function createZipStream(entries) {
  const central = [];
  let offset = 0;

  async function* generate() {
    for (const entry of entries) {
      const fs = require('fs');
      const content = await fs.promises.readFile(entry.filepath);
      const nameBuf = Buffer.from(entry.name, 'utf8');
      const crc = crc32(content);
      const { time, date } = dosDateTime(entry.mtime || new Date());

      const lh = localHeader(nameBuf, crc, content.length, time, date);
      yield Buffer.concat([lh, nameBuf, content]);

      central.push(Buffer.concat([centralHeader(nameBuf, crc, content.length, time, date, offset), nameBuf]));
      offset += lh.length + nameBuf.length + content.length;
    }

    let cdSize = 0;
    for (const h of central) cdSize += h.length;
    yield Buffer.concat([...central, endCentral(entries.length, cdSize, offset)]);
  }

  return Readable.from(generate(), { objectMode: false });
}

module.exports = { createZipStream, crc32 };
