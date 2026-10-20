const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { loadIndex, saveIndex, flush, getYears, getPhotos, getPhoto, addPhoto, photoById } = require('./lib/db');
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
      const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 100));
      return json(res, getPhotos(year, page, limit));
    }

    if (url.startsWith('/api/photo/') && url.endsWith('/thumb')) {
      const id = url.split('/')[3];
      const photo = getPhoto(id);
      if (!photo) { res.writeHead(404); return res.end(); }

      // Prefer cached thumbnail
      let thumbFile = hasThumb(id) ? id : null;
      if (!thumbFile) {
        const generated = generateThumbnail(photo.filepath, id);
        if (generated) thumbFile = id;
      }

      const filepath = thumbFile
        ? path.join(__dirname, '.thumbs', `${id}.jpg`)
        : photo.filepath;

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
      const entries = data.photos
        .filter(p => fs.existsSync(p.filepath))
        .map(p => ({ name: p.filename, filepath: p.filepath, mtime: p.taken_at ? new Date(p.taken_at) : undefined }));
      if (entries.length === 0) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="photos-${year}.zip"`,
        'Cache-Control': 'no-cache'
      });
      return createZipStream(entries).pipe(res);
    }

    if (url.startsWith('/api/photo/') && url.endsWith('/download')) {
      const id = url.split('/')[3];
      const photo = getPhoto(id);
      if (!photo || !fs.existsSync(photo.filepath)) { res.writeHead(404); return res.end(); }
      const stat = fs.statSync(photo.filepath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(photo.filename)}"`,
        'Cache-Control': 'no-cache'
      });
      return fs.createReadStream(photo.filepath).pipe(res);
    }

    if (url.startsWith('/api/photo/') && url.endsWith('/full')) {
      const id = url.split('/')[3];
      const photo = getPhoto(id);
      if (!photo || !fs.existsSync(photo.filepath)) { res.writeHead(404); return res.end(); }
      const stat = fs.statSync(photo.filepath);
      const ext = path.extname(photo.filepath).toLowerCase();
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
        return fs.createReadStream(photo.filepath, { start, end }).pipe(res);
      }

      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      });
      return fs.createReadStream(photo.filepath).pipe(res);
    }

    if (url.startsWith('/api/photo/') && req.method === 'DELETE') {
      const id = url.split('/')[3];
      const { deletePhoto } = require('./lib/db');
      const photo = deletePhoto(id);
      if (!photo) return json(res, { error: 'Not found' }, 404);
      // Delete file from disk + thumbnail
      try { if (fs.existsSync(photo.filepath)) fs.unlinkSync(photo.filepath); } catch (e) {}
      try { const t = path.join(__dirname, '.thumbs', `${id}.jpg`); if (fs.existsSync(t)) fs.unlinkSync(t); } catch (e) {}
      flush();
      return json(res, { deleted: id });
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

      const id = crypto.createHash('md5').update(filepath).digest('hex').slice(0, 16);

      const upExt = path.extname(safeName).toLowerCase();
      const upIsVideo = (upExt === '.mp4' || upExt === '.mov' || upExt === '.m4v' || upExt === '.avi' || upExt === '.mkv' || upExt === '.gif');
      addPhoto({
        id,
        filename: safeName,
        filepath,
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
