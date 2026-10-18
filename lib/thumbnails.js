// Server-side thumbnails using macOS `sips` (built-in, zero dependencies)
// Falls back to serving originals on non-macOS systems
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const THUMB_DIR = path.join(__dirname, '..', '.thumbs');
const THUMB_SIZE = 400;
const IS_MAC = os.platform() === 'darwin';

let sipsAvailable = false;
if (IS_MAC) {
  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
    sipsAvailable = true;
  } catch (e) { /* sips not available */ }
}

if (!fs.existsSync(THUMB_DIR)) {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
}

function thumbPath(id) {
  return path.join(THUMB_DIR, `${id}.jpg`);
}

function hasThumb(id) {
  return fs.existsSync(thumbPath(id));
}

function generateThumbnail(sourcePath, id) {
  const dest = thumbPath(id);
  if (fs.existsSync(dest)) return dest;
  if (!sipsAvailable) return null;

  try {
    execFileSync('sips', [
      '-Z', String(THUMB_SIZE),
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '70',
      sourcePath,
      '--out', dest
    ], { stdio: 'ignore' });
    return dest;
  } catch (err) {
    return null;
  }
}

module.exports = { generateThumbnail, hasThumb, thumbPath, sipsAvailable };
