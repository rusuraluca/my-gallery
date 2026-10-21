const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'photos.json');

// Photos are stored relative to the project root so the index survives
// moving/renaming the folder. Resolve back to an absolute path for fs ops.
function resolvePath(filepath) {
  if (!filepath) return filepath;
  return path.isAbsolute(filepath) ? filepath : path.join(ROOT, filepath);
}

function toRelative(filepath) {
  const rel = path.relative(ROOT, filepath);
  return rel.startsWith('..') ? filepath : rel;
}

// Normalize, dedupe and prune the index:
// - absolute paths (from older versions) → relative
// - entries whose file no longer exists → removed
// - duplicate files → keep the first
function normalizeIndex(photos) {
  const seen = new Set();
  const out = [];
  for (const photo of photos) {
    if (!photo || !photo.filepath) continue;
    const rel = toRelative(photo.filepath);
    if (seen.has(rel)) continue;
    if (!fs.existsSync(resolvePath(rel))) continue;
    seen.add(rel);
    photo.filepath = rel;
    out.push(photo);
  }
  return out;
}

let index = { photos: [], byId: {}, byYear: {} };
let filepathToId = new Map();
let saveTimer = null;
let dirty = false;

function loadIndex() {
  if (fs.existsSync(DB_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      index = data;
      if (!index.byId) index.byId = {};
      if (!index.byYear) index.byYear = {};
      const before = index.photos.length;
      index.photos = normalizeIndex(index.photos);
      const removed = before - index.photos.length;
      if (removed > 0) {
        console.log(`Index repaired: removed ${removed} stale/duplicate entr${removed === 1 ? 'y' : 'ies'}`);
        dirty = true;
      }
      rebuildIndexes();
    } catch (err) {
      console.error('Failed to load index, rebuilding...');
      index = { photos: [], byId: {}, byYear: {} };
      filepathToId = new Map();
    }
  }
}

function saveIndex() {
  fs.writeFileSync(DB_PATH, JSON.stringify(index));
  dirty = false;
}

// Debounced save — batch writes instead of one per photo
function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) saveIndex();
  }, 2000);
}

// Flush pending save on process exit
process.on('SIGINT', () => { if (dirty) saveIndex(); process.exit(0); });
process.on('SIGTERM', () => { if (dirty) saveIndex(); process.exit(0); });
process.on('exit', () => { if (dirty) saveIndex(); });

function rebuildIndexes() {
  index.byId = {};
  index.byYear = {};
  filepathToId = new Map();
  for (const photo of index.photos) {
    index.byId[photo.id] = photo;
    filepathToId.set(photo.filepath, photo.id);
    if (!index.byYear[photo.year]) index.byYear[photo.year] = [];
    index.byYear[photo.year].push(photo);
  }
}

function getYears() {
  const years = Object.entries(index.byYear).map(([year, photos]) => ({
    year: parseInt(year, 10),
    count: photos.length
  }));
  return years.sort((a, b) => b.year - a.year);
}

function getPhotos(year, page, limit) {
  const offset = (page - 1) * limit;
  let list;

  if (year && index.byYear[year]) {
    list = index.byYear[year];
  } else if (year) {
    list = [];
  } else {
    list = index.photos;
  }

  const total = list.length;
  const photos = list
    .slice()
    .sort((a, b) => (b.taken_at || '').localeCompare(a.taken_at || ''))
    .slice(offset, offset + limit);

  return { photos, total, page, pages: Math.ceil(total / limit) };
}

function getPhoto(id) {
  return index.byId[id] || null;
}

function addPhoto(photo) {
  if (index.byId[photo.id]) return;
  index.photos.push(photo);
  index.byId[photo.id] = photo;
  filepathToId.set(photo.filepath, photo.id);
  if (!index.byYear[photo.year]) index.byYear[photo.year] = [];
  index.byYear[photo.year].push(photo);
  scheduleSave();
}

function photoExists(filepath) {
  return filepathToId.has(filepath);
}

// The id a file is already stored under (it may differ from a freshly
// computed one if the index was built by an older version).
function photoIdForFilepath(filepath) {
  return filepathToId.get(filepath) || null;
}

function deletePhoto(id) {
  const photo = index.byId[id];
  if (!photo) return null;
  delete index.byId[id];
  filepathToId.delete(photo.filepath);
  index.photos = index.photos.filter(p => p.id !== id);
  if (index.byYear[photo.year]) {
    index.byYear[photo.year] = index.byYear[photo.year].filter(p => p.id !== id);
    if (index.byYear[photo.year].length === 0) delete index.byYear[photo.year];
  }
  scheduleSave();
  return photo;
}

// Bulk delete: one pass over the index and one rebuild instead of N of each
function deletePhotos(ids) {
  const idSet = new Set(ids);
  const removed = [];
  for (const id of idSet) {
    const photo = index.byId[id];
    if (photo) removed.push(photo);
  }
  if (removed.length === 0) return removed;

  index.photos = index.photos.filter(p => !idSet.has(p.id));
  rebuildIndexes();
  scheduleSave();
  return removed;
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (dirty) saveIndex();
}

module.exports = { loadIndex, saveIndex, flush, getYears, getPhotos, getPhoto, addPhoto, deletePhoto, deletePhotos, photoExists, photoIdForFilepath, rebuildIndexes, resolvePath, toRelative, ROOT, index };
