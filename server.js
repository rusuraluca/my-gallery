const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { loadIndex, saveIndex, flush, getYears, getPhotos, getPhoto, addPhoto, photoExists, resolvePath, toRelative } = require('./lib/db');
const { scanAll, PHOTOS_DIR } = require('./lib/scanner');
const { generateThumbnail, hasThumb } = require('./lib/thumbnails');
const { createZipStream } = require('./lib/zip');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif',
  '.tiff': 'image/tiff', '.tif': 'image/tiff',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filepath, cache = false) {
  if (!fs.existsSync(filepath)) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(filepath).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  // Long cache only for images; revalidate CSS/JS so updates land immediately
  if (cache && (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif' || ext === '.ico' || ext === '.woff2')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'no-cache';
  }
  const stat = fs.statSync(filepath);
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  fs.createReadStream(filepath).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 500 * 1024 * 1024) { req.destroy(); reject(new Error('Too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Stream a ZIP of the given photos directly to the client. Entries are
// resolved and existence-filtered up front; the archive itself is streamed.
function sendZip(res, photos, filename) {
  const entries = photos
    .map(p => ({ name: p.filename, filepath: resolvePath(p.filepath), mtime: p.taken_at ? new Date(p.taken_at) : undefined }))
    .filter(p => fs.existsSync(p.filepath));
  if (entries.length === 0) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-cache'
  });
  return createZipStream(entries).pipe(res);
}

// Remove photos from the index, then delete their files and thumbnails.
// Files are unlinked with bounded concurrency so a large bulk delete can't
// stall the event loop by opening thousands of fds at once.
async function removePhotos(ids, concurrency = 16) {
  const { deletePhotos } = require('./lib/db');
  const removed = deletePhotos(ids);
  if (removed.length === 0) return { deleted: 0, files: 0, thumbs: 0, ids: [] };

  const targets = [];
  for (const photo of removed) {
    targets.push(resolvePath(photo.filepath));
    targets.push(path.join(__dirname, '.thumbs', `${photo.id}.jpg`));
  }

  let files = 0;
  let thumbs = 0;
  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    const settled = await Promise.allSettled(chunk.map(p => fs.promises.unlink(p)));
    settled.forEach((r, j) => {
      if (r.status !== 'fulfilled') return;
      if (chunk[j].endsWith('.jpg') && chunk[j].includes('.thumbs')) thumbs++;
      else files++;
    });
  }

  flush();
  return { deleted: removed.length, files, thumbs, ids: removed.map(p => p.id) };
}

function parseQuery(url) {
  const q = {};
  const idx = url.indexOf('?');
  if (idx >= 0) {
    new URLSearchParams(url.slice(idx + 1)).forEach((v, k) => q[k] = v);
  }
  return q;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const query = parseQuery(req.url);

  try {
    // ── API ──
    if (url === '/api/years') {
      return json(res, getYears());
    }

    if (url === '/api/photos') {
      const year = query.year ? parseInt(query.year, 10) : null;
      const page = Math.max(1, parseInt(query.page, 10) || 1);
      const limit = Math.min(10000, Math.max(1, parseInt(query.limit, 10) || 100));
      return json(res, getPhotos(year, page, limit));
    }

    if (url.startsWith('/api/photo/') && url.endsWith('/thumb')) {
      const id = url.split('/')[3];
      const photo = getPhoto(id);
      if (!photo) { res.writeHead(404); return res.end(); }

      // Prefer cached thumbnail
      let thumbFile = hasThumb(id) ? id : null;
      if (!thumbFile) {
        const generated = generateThumbnail(resolvePath(photo.filepath), id);
        if (generated) thumbFile = id;
      }

      const filepath = thumbFile
        ? path.join(__dirname, '.thumbs', `${id}.jpg`)
        : resolvePath(photo.filepath);

      if (!fs.existsSync(filepath)) { res.writeHead(404); return res.end(); }
      const stat = fs.statSync(filepath);
      const ext = path.extname(filepath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'image/jpeg',
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=604800'
      });
      return fs.createReadStream(filepath).pipe(res);
    }

    if (url.startsWith('/api/year/') && url.endsWith('/zip')) {
      const year = parseInt(url.split('/')[3], 10);
      const data = getPhotos(year, 1, 100000);
      return sendZip(res, data.photos, `photos-${year}.zip`);
    }

    // ZIP of an explicit selection, so a browser download streams it straight
    // to disk instead of buffering the archive in memory first.
    if (url === '/api/photos/zip') {
      const ids = (query.ids || '').split(',').filter(Boolean).slice(0, 5000);
      if (ids.length === 0) return json(res, { error: 'No ids given' }, 400);
      const photos = ids.map(getPhoto).filter(Boolean);
      if (photos.length === 0) return json(res, { error: 'Not found' }, 404);
      return sendZip(res, photos, `selected-${photos.length}.zip`);
    }

    if (url.startsWith('/api/photo/') && url.endsWith('/download')) {
      const id = url.split('/')[3];
      const photo = getPhoto(id);
      const abs = photo && resolvePath(photo.filepath);
      if (!photo || !fs.existsSync(abs)) { res.writeHead(404); return res.end(); }
      const stat = fs.statSync(abs);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(photo.filename)}"`,
        'Cache-Control': 'no-cache'
      });
      return fs.createReadStream(abs).pipe(res);
    }

    if (url.startsWith('/api/photo/') && url.endsWith('/full')) {
      const id = url.split('/')[3];
      const photo = getPhoto(id);
      const abs = photo && resolvePath(photo.filepath);
      if (!photo || !fs.existsSync(abs)) { res.writeHead(404); return res.end(); }
      const stat = fs.statSync(abs);
      const ext = path.extname(abs).toLowerCase();
      const type = MIME[ext] || 'image/jpeg';
      const range = req.headers.range;

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
        end = Math.min(end, stat.size - 1);
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'public, max-age=3600'
        });
        return fs.createReadStream(abs, { start, end }).pipe(res);
      }

      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      });
      return fs.createReadStream(abs).pipe(res);
    }

    // Delete one or many: DELETE /api/photo/:id  or  POST /api/photos/delete {ids:[...]}
    if (url.startsWith('/api/photo/') && req.method === 'DELETE') {
      const { deletePhotos } = require('./lib/db');
      const result = await removePhotos([url.split('/')[3]]);
      if (result.deleted === 0) return json(res, { error: 'Not found' }, 404);
      return json(res, { deleted: result.ids[0] });
    }

    if (url === '/api/photos/delete' && req.method === 'POST') {
      const { deletePhotos } = require('./lib/db');
      let payload;
      try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return json(res, { error: 'Invalid JSON' }, 400); }
      const ids = Array.isArray(payload.ids) ? payload.ids.filter(id => typeof id === 'string') : [];
      if (ids.length === 0) return json(res, { error: 'No ids given' }, 400);
      if (ids.length > 10000) return json(res, { error: 'Too many ids' }, 400);
      const result = await removePhotos(ids);
      return json(res, { deleted: result.deleted, files: result.files, thumbs: result.thumbs });
    }

    if (url.startsWith('/api/photo/')) {
      const id = url.split('/')[3];
      const photo = getPhoto(id);
      if (!photo) return json(res, { error: 'Not found' }, 404);
      return json(res, photo);
    }

    if (url === '/api/scan' && req.method === 'POST') {
      const count = await scanAll();
      return json(res, { indexed: count });
    }

    if (url === '/api/upload' && req.method === 'POST') {
      const filename = decodeURIComponent(query.filename || 'upload.jpg');
      const body = await readBody(req);

      // Determine year from EXIF or current date
      const { parseExifDate } = require('./lib/exif');
      const exifDate = parseExifDate(body);
      const now = new Date();
      const takenDate = exifDate || now;
      const year = takenDate.getFullYear();
      const month = takenDate.getMonth() + 1;
      const day = takenDate.getDate();

      // Save to year folder
      const yearDir = path.join(PHOTOS_DIR, String(year));
      fs.mkdirSync(yearDir, { recursive: true });

      const safeName = `${Date.now()}_${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const filepath = path.join(yearDir, safeName);
      fs.writeFileSync(filepath, body);

      const rel = toRelative(filepath);
      const id = crypto.createHash('md5').update(rel).digest('hex').slice(0, 16);

      const upExt = path.extname(safeName).toLowerCase();
      const upIsVideo = (upExt === '.mp4' || upExt === '.mov' || upExt === '.m4v' || upExt === '.avi' || upExt === '.mkv' || upExt === '.gif');
      addPhoto({
        id,
        filename: safeName,
        filepath: rel,
        year, month, day,
        taken_at: takenDate.toISOString(),
        width: null,
        height: null,
        filesize: body.length,
        type: upIsVideo ? 'video' : 'photo'
      });

      generateThumbnail(filepath, id);
      flush();

      return json(res, { uploaded: 1, photos: [{ id, filename: safeName, year }] });
    }

    // ── Static files ──
    let filepath = path.join(PUBLIC_DIR, url === '/' ? 'index.html' : url);
    filepath = path.normalize(filepath);
    if (!filepath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }

    if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
      return serveFile(res, filepath, url !== '/' && !url.endsWith('.html'));
    }

    // SPA fallback
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  } catch (err) {
    console.error(err);
    json(res, { error: err.message }, 500);
  }
});

loadIndex();
server.listen(PORT, '0.0.0.0', () => {
  const nets = Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal);
  console.log(`\n  Photos running:`);
  console.log(`  → http://localhost:${PORT}`);
  nets.forEach(n => console.log(`  → http://${n.address}:${PORT}  (your iPhone)`));
  console.log('');
  scanAll().catch(console.error);
});
