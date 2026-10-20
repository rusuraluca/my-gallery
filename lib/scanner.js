const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { addPhoto, photoExists, flush } = require('./db');
const { parseExifDate } = require('./exif');
const { generateThumbnail, sipsAvailable } = require('./thumbnails');

const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const MEDIA_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tiff', '.tif', '.gif', '.mp4', '.mov', '.m4v', '.avi', '.mkv']);

function walk(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (MEDIA_EXT.has(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

function id(filepath) {
  return crypto.createHash('md5').update(filepath).digest('hex').slice(0, 16);
}

function yearFromPath(filepath) {
  const rel = path.relative(PHOTOS_DIR, filepath);
  const m = rel.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

async function scanAll() {
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });

  const files = walk(PHOTOS_DIR);
  console.log(`Scanning ${files.length} media files...`);

  let indexed = 0;
  for (const filepath of files) {
    if (photoExists(filepath)) continue;

    const stat = fs.statSync(filepath);
    const filename = path.basename(filepath);
    const photoId = id(filepath);

    let takenDate = null;
    let year = null;
    let month = null;
    let day = null;

    // Try EXIF for JPEG files
    const ext = path.extname(filepath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') {
      try {
        const fd = fs.openSync(filepath, 'r');
        const header = Buffer.alloc(65536);
        fs.readSync(fd, header, 0, 65536, 0);
        fs.closeSync(fd);
        takenDate = parseExifDate(header);
      } catch (err) { /* fall through */ }
    }

    if (!takenDate) {
      year = yearFromPath(filepath);
      if (year) {
        takenDate = new Date(year, 0, 1);
      }
    }

    if (takenDate) {
      year = takenDate.getFullYear();
      month = takenDate.getMonth() + 1;
      day = takenDate.getDate();
    }

    if (!year) {
      year = stat.mtime.getFullYear();
      month = stat.mtime.getMonth() + 1;
      day = stat.mtime.getDate();
      takenDate = stat.mtime;
    }

    // Read dimensions from header
    let width = null, height = null;
    try {
      const dims = readDimensions(filepath, ext);
      width = dims.width;
      height = dims.height;
    } catch (err) { /* optional */ }

    const isVideo = (ext === '.mp4' || ext === '.mov' || ext === '.m4v' || ext === '.avi' || ext === '.mkv' || ext === '.gif');
    addPhoto({
      id: photoId,
      filename,
      filepath,
      year,
      month,
      day,
      taken_at: (takenDate || stat.mtime).toISOString(),
      width: isVideo ? null : width,
      height: isVideo ? null : height,
      filesize: stat.size,
      type: isVideo ? 'video' : 'photo'
    });

    // Generate thumbnail (macOS sips, skips if already exists)
    generateThumbnail(filepath, photoId);

    indexed++;
    if (indexed % 200 === 0) {
      console.log(`  ${indexed}/${files.length}...`);
      flush(); // periodic flush during large scans
    }
  }

  flush(); // final save
  console.log(`Indexed ${indexed} new photos (${files.length} total files${sipsAvailable ? ', thumbnails generated' : ''})`);
  return indexed;
}

function readDimensions(filepath, ext) {
  const fd = fs.openSync(filepath, 'r');
  try {
    const buf = Buffer.alloc(32);

    if (ext === '.png') {
      fs.readSync(fd, buf, 0, 24, 0);
      if (buf.readUInt32BE(0) === 0x89504E47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
    }

    if (ext === '.jpg' || ext === '.jpeg') {
      // Read first 200KB and scan for SOF marker
      const size = Math.min(fs.statSync(filepath).size, 200000);
      const data = Buffer.alloc(size);
      fs.readSync(fd, data, 0, size, 0);

      let pos = 2;
      while (pos < size - 9) {
        if (data[pos] !== 0xFF) break;
        const marker = data[pos + 1];
        if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2 || marker === 0xC3) {
          return {
            height: data.readUInt16BE(pos + 5),
            width: data.readUInt16BE(pos + 7)
          };
        }
        if (marker === 0xDA) break;
        if (marker >= 0xD0 && marker <= 0xD9) { pos += 2; continue; }
        pos += 2 + data.readUInt16BE(pos + 2);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { width: null, height: null };
}

module.exports = { scanAll, PHOTOS_DIR };
