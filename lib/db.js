const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'photos.json');

let index = { photos: [], byId: {}, byYear: {} };
let filepathSet = new Set();
let saveTimer = null;
let dirty = false;

function loadIndex() {
  if (fs.existsSync(DB_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      index = data;
      if (!index.byId) index.byId = {};
      if (!index.byYear) index.byYear = {};
      filepathSet = new Set(index.photos.map(p => p.filepath));
    } catch (err) {
      console.error('Failed to load index, rebuilding...');
      index = { photos: [], byId: {}, byYear: {} };
      filepathSet = new Set();
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
  filepathSet = new Set();
  for (const photo of index.photos) {
    index.byId[photo.id] = photo;
    filepathSet.add(photo.filepath);
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
  filepathSet.add(photo.filepath);
  if (!index.byYear[photo.year]) index.byYear[photo.year] = [];
  index.byYear[photo.year].push(photo);
  scheduleSave();
}

function photoExists(filepath) {
  return filepathSet.has(filepath);
}

function deletePhoto(id) {
  const photo = index.byId[id];
  if (!photo) return null;
  delete index.byId[id];
  filepathSet.delete(photo.filepath);
  index.photos = index.photos.filter(p => p.id !== id);
  if (index.byYear[photo.year]) {
    index.byYear[photo.year] = index.byYear[photo.year].filter(p => p.id !== id);
    if (index.byYear[photo.year].length === 0) delete index.byYear[photo.year];
  }
  scheduleSave();
  return photo;
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (dirty) saveIndex();
}

module.exports = { loadIndex, saveIndex, flush, getYears, getPhotos, getPhoto, addPhoto, deletePhoto, photoExists, rebuildIndexes, index };
