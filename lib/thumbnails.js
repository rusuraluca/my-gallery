// Server-side thumbnails using macOS `sips` (built-in, zero dependencies)
// Videos use `qlmanage` for a poster frame. Falls back to originals on non-macOS.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const THUMB_DIR = path.join(__dirname, '..', '.thumbs');
const THUMB_SIZE = 800;
const IS_MAC = os.platform() === 'darwin';
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv']);

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

  const ext = path.extname(sourcePath).toLowerCase();

  if (VIDEO_EXT.has(ext)) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-'));
    try {
      execFileSync('qlmanage', ['-t', '-s', String(THUMB_SIZE), '-o', tmpDir, sourcePath], { stdio: 'ignore' });
      const produced = fs.readdirSync(tmpDir).find(f => f.toLowerCase().endsWith('.png'));
      if (produced) {
        execFileSync('sips', [
          '-Z', String(THUMB_SIZE),
          '-s', 'format', 'jpeg',
          '-s', 'formatOptions', '70',
          path.join(tmpDir, produced),
          '--out', dest
        ], { stdio: 'ignore' });
        return dest;
      }
    } catch (err) { /* fall through */ } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
    return null;
  }

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
