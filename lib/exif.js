// Minimal JPEG EXIF date parser — pure Node.js, zero dependencies
// Extracts DateTimeOriginal (tag 0x9003) from JPEG APP1 segment

function parseExifDate(buffer) {
  try {
    if (buffer.length < 4) return null;
    // Must be JPEG: FF D8
    if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;

    let pos = 2;
    while (pos < buffer.length - 4) {
      if (buffer[pos] !== 0xFF) break;
      const marker = buffer[pos + 1];

      // APP1 (Exif)
      if (marker === 0xE1) {
        const size = buffer.readUInt16BE(pos + 2);
        const segStart = pos + 4;
        // Check for "Exif\0\0"
        if (buffer.toString('ascii', segStart, segStart + 4) === 'Exif') {
          return parseTiff(buffer, segStart + 6, segStart + 6 + size - 8);
        }
        pos += 2 + size;
        continue;
      }

      // SOS — start of scan, no more metadata
      if (marker === 0xDA) break;

      // Skip other markers
      if (marker >= 0xD0 && marker <= 0xD9) { pos += 2; continue; }
      const size = buffer.readUInt16BE(pos + 2);
      pos += 2 + size;
    }
  } catch (err) {
    // Not parseable, that's fine
  }
  return null;
}

function parseTiff(buffer, start, end) {
  if (buffer.length < start + 8) return null;
  const byteOrder = buffer.toString('ascii', start, start + 2);
  const little = byteOrder === 'II';

  function read16(offset) {
    return little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  }
  function read32(offset) {
    return little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  }

  const ifdOffset = read32(start + 4);
  return readIfd(buffer, start, start + ifdOffset, end, little, read16, read32, start);
}

function readIfd(buffer, tiffStart, ifdStart, end, little, read16, read32, base) {
  const entryCount = read16(ifdStart);
  const wantedTags = [0x9003, 0x0132, 0x9004]; // DateTimeOriginal, DateTime, DateTimeDigitized

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdStart + 2 + i * 12;
    if (entryOffset + 12 > buffer.length) break;

    const tag = read16(entryOffset);
    if (!wantedTags.includes(tag)) continue;

    const type = read16(entryOffset + 2);
    const count = read32(entryOffset + 4);

    // ASCII type (2), value stored inline if <= 4 bytes, else offset
    if (type === 2 && count > 0) {
      let valueOffset;
      if (count <= 4) {
        valueOffset = entryOffset + 8;
      } else {
        const ptr = read32(entryOffset + 8);
        valueOffset = tiffStart + ptr;
      }

      if (valueOffset + count > buffer.length) continue;
      const str = buffer.toString('ascii', valueOffset, valueOffset + Math.min(count, 20));

      // Format: "2024:06:15 14:30:00"
      const match = str.match(/(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
      if (match) {
        const [, y, mo, d, h, mi, s] = match.map(Number);
        if (y > 1900 && y < 2100) {
          return new Date(y, mo - 1, d, h, mi, s);
        }
      }
    }
  }

  // Check for Exif IFD pointer (tag 0x8769)
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdStart + 2 + i * 12;
    if (entryOffset + 12 > buffer.length) break;
    const tag = read16(entryOffset);
    if (tag === 0x8769) {
      const ptr = read32(entryOffset + 8);
      const exifIfd = tiffStart + ptr;
      if (exifIfd < end) {
        const result = readIfd(buffer, tiffStart, exifIfd, end, little, read16, read32, base);
        if (result) return result;
      }
    }
  }

  return null;
}

module.exports = { parseExifDate };
