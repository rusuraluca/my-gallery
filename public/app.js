(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  const state = {
    photos: [],
    year: null,
    page: 1,
    pages: 1,
    total: 0,
    loading: false,
    currentIndex: 0,
    years: [],
    selectMode: false,
    selected: new Set()
  };

  const grid = $('#photo-grid');

  // ── Toasts ─────────────────────────────────────
  function showToast(message, type = 'info', duration = 3200) {
    const container = $('#toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = {
      success: '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M13.8 4.2a1 1 0 010 1.4l-6.4 6.4a1 1 0 01-1.4 0L2.2 8.2a1 1 0 111.4-1.4l3.1 3.1 5.7-5.7a1 1 0 011.4 0z"/></svg>',
      error: '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 7.5a1 1 0 110-2 1 1 0 010 2z"/></svg>',
      info: '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3.5a1 1 0 110 2 1 1 0 010-2zM6.75 8a.75.75 0 000 1.5H7.3v2.25H6.75a.75.75 0 000 1.5h2.5a.75.75 0 000-1.5H8.8V8.75A.75.75 0 008.05 8H6.75z"/></svg>'
    };
    toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-msg"></span>`;
    toast.querySelector('.toast-msg').textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    if (duration > 0) {
      setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
      }, duration);
    }
    return toast;
  }
  const lightbox = $('#lightbox');
  const lbImg = $('#lb-img');
  const infoPanel = $('#info-panel');
  const uploadModal = $('#upload-modal');

  // ── Theme ──────────────────────────────────────
  function initTheme() {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    setTheme(theme);
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#000000' : '#ffffff';
  }

  $('#theme-btn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'light' : 'dark');
  });

  // ── API ────────────────────────────────────────
  async function fetchYears() {
    const res = await fetch('/api/years');
    state.years = await res.json();
    renderYears();
  }

  async function fetchPhotos(year, page) {
    const params = new URLSearchParams({ page: String(page), limit: '10000' });
    if (year) params.set('year', String(year));
    const res = await fetch(`/api/photos?${params}`);
    return res.json();
  }

  // ── Render Years ──────────────────────────────
  function renderYears() {
    const container = $('#years-list');
    container.innerHTML = state.years.map(y => `
      <button class="nav-item ${state.year === y.year ? 'active' : ''}" data-year="${y.year}">
        <span>${y.year}</span>
        <span class="year-count">${formatCount(y.count)}</span>
      </button>
    `).join('');

    container.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const year = parseInt(btn.dataset.year, 10);
        selectYear(year === state.year ? null : year);
        closeSidebar();
      });
    });
  }

  function formatCount(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'k';
    return String(n);
  }

  // ── Select Year ────────────────────────────────
  async function selectYear(year) {
    state.year = year;
    state.page = 1;
    state.photos = [];
    state.pages = 1;

    $('#current-title').textContent = year ? String(year) : 'All Photos';
    $('#mobile-title').textContent = year ? String(year) : 'Photos';
    $('#header-download').hidden = !year;
    grid.innerHTML = '';
    $('#empty-state').hidden = true;

    $$('.nav-item').forEach(el => el.classList.remove('active'));
    if (year) {
      const btn = document.querySelector(`.nav-item[data-year="${year}"]`);
      if (btn) btn.classList.add('active');
    } else {
      $('#nav-all').classList.add('active');
    }

    await loadPage();
  }

  async function loadPage() {
    if (state.loading || state.page > state.pages) return;
    state.loading = true;
    $('#loading').hidden = state.photos.length > 0;

    try {
      const data = await fetchPhotos(state.year, state.page);
      state.total = data.total;
      state.pages = data.pages;
      state.photos.push(...data.photos);

      renderPhotos(data.photos);
      updateCount();

      if (state.photos.length === 0) {
        $('#empty-state').hidden = false;
      }

      state.page++;
    } catch (err) {
      console.error('Failed to load photos:', err);
    } finally {
      state.loading = false;
      $('#loading').hidden = true;
    }
  }

  function updateCount() {
    const count = state.total;
    $('#photo-count').textContent = count > 0 ? `${formatCount(count)} item${count !== 1 ? 's' : ''}` : '';
  }

  // ── Render Photos ─────────────────────────────
  function renderPhotos(photos) {
    let lastYear = null;
    const showYearHeaders = !state.year;

    const fragment = document.createDocumentFragment();

    photos.forEach((photo, i) => {
      if (showYearHeaders && photo.year !== lastYear) {
        lastYear = photo.year;
        const divider = document.createElement('div');
        divider.className = 'year-divider';
        const count = state.years.find(y => y.year === photo.year)?.count || '';
        divider.innerHTML = `<h3>${photo.year}</h3><span>${formatCount(count)} items</span>`;
        fragment.appendChild(divider);
      }

      const item = document.createElement('div');
      item.className = 'photo-item';
      item.dataset.id = photo.id;
      // Known aspect ratio lets masonry reserve space before the image loads
      item.dataset.w = photo.width || 1600;
      item.dataset.h = photo.height || 900;

      const img = document.createElement('img');
      img.alt = photo.filename;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = item.dataset.w;
      img.height = item.dataset.h;
      img.src = `/api/photo/${photo.id}/thumb`;
      item.appendChild(img);

      if (photo.type === 'video' || /\.(mp4|mov|m4v|avi|mkv|gif)$/i.test(photo.filename)) {
        const overlay = document.createElement('div');
        overlay.className = 'video-overlay';
        overlay.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor"><path d="M5 3.5v11l9-5.5z"/></svg>';
        item.appendChild(overlay);
      }
      item.addEventListener('click', () => {
        if (state.selectMode) toggleSelect(photo.id, item);
        else openLightbox(state.photos.indexOf(photo));
      });
      fragment.appendChild(item);
    });

    grid.appendChild(fragment);
    layoutMasonry();
  }

  // ── Masonry ─────────────────────────────────────
  // Tiles span whole grid rows based on their real aspect ratio, so photos
  // keep their shape and pack tightly instead of being cropped to squares.
  const MASONRY_ROW = 4;
  function masonryGap() {
    return parseFloat(getComputedStyle(grid).rowGap) || 6;
  }

  function layoutMasonry() {
    const gap = masonryGap();
    grid.querySelectorAll('.photo-item').forEach(item => {
      const w = item.getBoundingClientRect().width;
      if (!w) return;
      const nw = parseFloat(item.dataset.w) || 16;
      const nh = parseFloat(item.dataset.h) || 9;
      const span = Math.max(1, Math.ceil((w * nh / nw + gap) / (MASONRY_ROW + gap)));
      item.style.gridRowEnd = `span ${span}`;
    });
  }

  let masonryRaf = null;
  function scheduleMasonry() {
    if (masonryRaf) return;
    masonryRaf = requestAnimationFrame(() => { masonryRaf = null; layoutMasonry(); });
  }

  // Re-measure once a real image size is known, and when the grid is resized
  grid.addEventListener('load', e => {
    if (e.target.tagName !== 'IMG') return;
    const item = e.target.closest('.photo-item');
    if (item && e.target.naturalWidth) {
      item.dataset.w = e.target.naturalWidth;
      item.dataset.h = e.target.naturalHeight;
    }
    scheduleMasonry();
  }, true);

  new ResizeObserver(scheduleMasonry).observe(grid);

  // ── Lightbox ───────────────────────────────────
  function openLightbox(index) {
    state.currentIndex = index;
    lightbox.hidden = false;
    requestAnimationFrame(() => lightbox.classList.add('visible'));
    showLightboxImage(index);
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.remove('visible');
    infoPanel.classList.remove('visible');
    infoPanel.hidden = true;
    setTimeout(() => {
      lightbox.hidden = true;
      const cur = document.querySelector('#lb-img'); if (cur) cur.classList.remove('visible');
    }, 300);
    document.body.style.overflow = '';
  }

  function showLightboxImage(index) {
    const photo = state.photos[index];
    if (!photo) return;

    const wrap = document.querySelector('.lb-image-wrap');
    wrap.innerHTML = '';
    const isVideo = photo.type === 'video' || /\.(mp4|mov|m4v|avi|mkv|gif)$/i.test(photo.filename);

    if (isVideo) {
      const v = document.createElement('video');
      v.id = 'lb-img';
      v.controls = true;
      v.autoplay = false;
      v.playsInline = true;
      v.src = `/api/photo/${photo.id}/full`;
      v.classList.add('visible');
      wrap.appendChild(v);
      try { v.load(); } catch (e) {}
      setTimeout(() => v.play().catch(()=>{}), 100);
    } else {
      const img = document.createElement('img');
      img.id = 'lb-img';
      img.src = `/api/photo/${photo.id}/full`;
      img.onload = () => img.classList.add('visible');
      img.onerror = () => { img.src = `/api/photo/${photo.id}/thumb`; };
      wrap.appendChild(img);
    }
  }

  function navigateLightbox(delta) {
    const next = state.currentIndex + delta;
    if (next < 0 || next >= state.photos.length) return;
    state.currentIndex = next;
    showLightboxImage(next);
  }

  $('#lb-close').addEventListener('click', closeLightbox);
  $('#lb-prev').addEventListener('click', () => navigateLightbox(-1));
  $('#lb-next').addEventListener('click', () => navigateLightbox(1));

  lightbox.addEventListener('click', e => {
    if (e.target === lightbox || e.target.classList.contains('lb-image-wrap')) {
      closeLightbox();
    }
  });

  // Swipe support
  let touchStartX = 0;
  let touchStartY = 0;
  lightbox.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  lightbox.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      navigateLightbox(dx > 0 ? -1 : 1);
    }
  }, { passive: true });

  // ── Info Panel ─────────────────────────────────
  $('#lb-info').addEventListener('click', () => {
    const photo = state.photos[state.currentIndex];
    if (!photo) return;

    const rows = [];
    if (photo.taken_at) {
      const d = new Date(photo.taken_at);
      rows.push(['Date', d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })]);
      rows.push(['Time', d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })]);
    }
    if (photo.width && photo.height) {
      rows.push(['Dimensions', `${photo.width} × ${photo.height}`]);
    }
    if (photo.filesize) {
      rows.push(['File Size', formatBytes(photo.filesize)]);
    }
    rows.push(['Filename', photo.filename]);
    rows.push(['Year', String(photo.year)]);

    $('#info-body').innerHTML = rows.map(([label, value]) => `
      <div class="info-row">
        <span class="info-label">${label}</span>
        <span class="info-value">${escHtml(value)}</span>
      </div>
    `).join('');

    infoPanel.hidden = false;
    requestAnimationFrame(() => infoPanel.classList.add('visible'));
  });

  $('#info-close').addEventListener('click', () => {
    infoPanel.classList.remove('visible');
    setTimeout(() => infoPanel.hidden = true, 350);
  });

  // ── Delete ─────────────────────────────────────
  $('#lb-delete').addEventListener('click', async () => {
    const photo = state.photos[state.currentIndex];
    if (!photo) return;
    if (!confirm(`Delete "${photo.filename}"?\n\nThis removes the file from disk permanently.`)) return;

    const id = photo.id;
    const idx = state.currentIndex;

    try {
      const r = await fetch(`/api/photo/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Delete failed');

      state.photos.splice(idx, 1);
      const y = state.years.find(y => y.year === photo.year);
      if (y) { y.count--; if (y.count <= 0) state.years = state.years.filter(v => v.year !== photo.year); }
      state.total--;
      showToast(`Deleted "${photo.filename}"`, 'success');

      if (state.photos.length === 0) {
        closeLightbox();
        renderYears();
        updateCount();
        $('#empty-state').hidden = false;
        return;
      }
      if (idx >= state.photos.length) state.currentIndex = state.photos.length - 1;
      showLightboxImage(state.currentIndex);
      renderYears();
      updateCount();
    } catch (err) {
      showToast('Failed to delete: ' + err.message, 'error');
    }
  });

  // ── Share ──────────────────────────────────────
  $('#lb-share').addEventListener('click', async () => {
    const photo = state.photos[state.currentIndex];
    if (!photo) return;
    const url = `${location.origin}/api/photo/${photo.id}/full`;
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      const mime = blob.type || resp.headers.get('content-type') || 'application/octet-stream';
      const file = new File([blob], photo.filename, { type: mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'My Gallery' });
        return;
      }
      if (navigator.share) {
        await navigator.share({ title: photo.filename, url });
        return;
      }
      const dl = document.createElement('a');
      dl.href = URL.createObjectURL(blob);
      dl.download = photo.filename;
      document.body.appendChild(dl);
      dl.click();
      document.body.removeChild(dl);
      URL.revokeObjectURL(dl.href);
      showToast(`Saved "${photo.filename}"`, 'success');
    } catch (err) {
      if (err.name === 'AbortError') return;
      const dl = document.createElement('a');
      dl.href = url;
      dl.download = photo.filename;
      document.body.appendChild(dl);
      dl.click();
      document.body.removeChild(dl);
      showToast('Sharing unavailable — downloaded instead', 'info');
    }
  });

  // ── Download (single) ──────────────────────────
  $('#lb-download').addEventListener('click', () => {
    const photo = state.photos[state.currentIndex];
    if (!photo) return;
    const a = document.createElement('a');
    a.href = `/api/photo/${photo.id}/download`;
    a.download = photo.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(`Downloading "${photo.filename}"`, 'info');
  });

  // ── Download (year ZIP) ────────────────────────
  $('#header-download').addEventListener('click', () => {
    if (!state.year) return;
    const a = document.createElement('a');
    a.href = `/api/year/${state.year}/zip`;
    a.download = `photos-${state.year}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(`Preparing ZIP of ${state.year}…`, 'info');
  });

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function escHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // ── Bulk select ────────────────────────────────
  const selectBar = $('#select-bar');
  const selectCount = $('#select-count');
  const selectDeleteBtn = $('#select-delete-btn');

  function setSelectMode(on) {
    state.selectMode = on;
    state.selected.clear();
    grid.classList.toggle('select-mode', on);
    selectBar.hidden = !on;
    $('#header-select').classList.toggle('active', on);
    $('#header-download').hidden = on || !state.year;
    grid.querySelectorAll('.photo-item.selected').forEach(el => el.classList.remove('selected'));
    updateSelectBar();
  }

  function updateSelectBar() {
    const n = state.selected.size;
    selectCount.textContent = `${n} selected`;
    selectDeleteBtn.disabled = n === 0;
    selectDeleteBtn.textContent = n ? `Delete ${n}` : 'Delete';
    $('#select-all-btn').textContent = n >= state.photos.length && n > 0 ? 'Clear' : 'Select all';
  }

  function toggleSelect(id, item) {
    if (state.selected.has(id)) {
      state.selected.delete(id);
      item.classList.remove('selected');
    } else {
      state.selected.add(id);
      item.classList.add('selected');
    }
    updateSelectBar();
  }

  function setAllSelected(on) {
    state.selected.clear();
    grid.querySelectorAll('.photo-item').forEach(el => {
      el.classList.toggle('selected', on);
      if (on) state.selected.add(el.dataset.id);
    });
    updateSelectBar();
  }

  $('#header-select').addEventListener('click', () => setSelectMode(!state.selectMode));
  $('#select-cancel-btn').addEventListener('click', () => setSelectMode(false));
  $('#select-all-btn').addEventListener('click', () => {
    const allSelected = state.selected.size >= state.photos.length && state.photos.length > 0;
    setAllSelected(!allSelected);
  });

  selectDeleteBtn.addEventListener('click', async () => {
    const ids = [...state.selected];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} item${ids.length !== 1 ? 's' : ''}?\n\nThis removes the files from disk and cannot be undone.`)) return;

    selectDeleteBtn.disabled = true;
    selectDeleteBtn.textContent = 'Deleting…';

    try {
      const res = await fetch('/api/photos/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const data = await res.json();

      // Update state and DOM in one pass — no refetch, no re-render of the rest
      const idSet = new Set(ids);
      const removedByYear = {};
      for (const photo of state.photos) {
        if (idSet.has(photo.id)) removedByYear[photo.year] = (removedByYear[photo.year] || 0) + 1;
      }
      state.photos = state.photos.filter(p => !idSet.has(p.id));
      state.total = state.photos.length;
      grid.querySelectorAll('.photo-item').forEach(el => {
        if (idSet.has(el.dataset.id)) el.remove();
      });

      for (const [year, count] of Object.entries(removedByYear)) {
        const y = state.years.find(v => v.year === parseInt(year, 10));
        if (y) {
          y.count -= count;
          if (y.count <= 0) state.years = state.years.filter(v => v.year !== parseInt(year, 10));
        }
      }

      state.selected.clear();
      setSelectMode(false);
      renderYears();
      updateCount();
      layoutMasonry();

      if (state.photos.length === 0) $('#empty-state').hidden = false;
      showToast(`Deleted ${data.deleted} item${data.deleted !== 1 ? 's' : ''}`, 'success');
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
      selectDeleteBtn.disabled = false;
      updateSelectBar();
    }
  });

  // ── Keyboard ───────────────────────────────────
  document.addEventListener('keydown', e => {
    if (!lightbox.hidden) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') navigateLightbox(-1);
      if (e.key === 'ArrowRight') navigateLightbox(1);
      if (e.key === 'i' || e.key === 'I') $('#lb-info').click();
    } else {
      if (e.key === 'Escape') {
        if (state.selectMode) setSelectMode(false);
        else closeSidebar();
      }
    }
  });

  // ── Upload ─────────────────────────────────────
  function openUpload() {
    uploadModal.hidden = false;
    requestAnimationFrame(() => uploadModal.classList.add('visible'));
    $('#upload-progress').hidden = true;
    $('#progress-fill').style.width = '0%';
  }

  function closeUpload() {
    uploadModal.classList.remove('visible');
    setTimeout(() => uploadModal.hidden = true, 250);
  }

  $('#upload-btn').addEventListener('click', openUpload);
  $('#mobile-upload-btn').addEventListener('click', openUpload);
  $('#modal-close').addEventListener('click', closeUpload);
  uploadModal.addEventListener('click', e => {
    if (e.target === uploadModal) closeUpload();
  });

  const uploadArea = $('#upload-area');
  const fileInput = $('#file-input');

  $('#file-picker-btn').addEventListener('click', e => {
    e.stopPropagation();
    fileInput.click();
  });

  uploadArea.addEventListener('click', () => fileInput.click());

  ['dragover', 'dragenter'].forEach(ev => {
    uploadArea.addEventListener(ev, e => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(ev => {
    uploadArea.addEventListener(ev, e => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
    });
  });

  uploadArea.addEventListener('drop', e => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length) uploadFiles(files);
  });

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    if (files.length) uploadFiles(files);
    fileInput.value = '';
  });

  async function uploadFiles(files) {
    $('#upload-progress').hidden = false;
    $('#progress-fill').style.width = '0%';

    let done = 0;
    for (const file of files) {
      $('#progress-text').textContent = `Uploading ${done + 1}/${files.length}: ${file.name}`;

      try {
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.addEventListener('progress', e => {
            if (e.lengthComputable) {
              const filePct = (e.loaded / e.total) * 100;
              const totalPct = ((done + filePct / 100) / files.length) * 100;
              $('#progress-fill').style.width = `${totalPct}%`;
            }
          });
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`Failed: ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.open('POST', `/api/upload?filename=${encodeURIComponent(file.name)}`);
          xhr.send(file);
        });
        done++;
      } catch (err) {
        $('#progress-text').textContent = `Error on ${file.name}: ${err.message}`;
        showToast(`Error on ${file.name}: ${err.message}`, 'error');
        return;
      }
    }

    $('#progress-text').textContent = `Uploaded ${done} photo${done > 1 ? 's' : ''}!`;
    $('#progress-fill').style.width = '100%';
    showToast(`Uploaded ${done} item${done !== 1 ? 's' : ''}`, 'success');

    setTimeout(() => {
      closeUpload();
      fetchYears();
      selectYear(state.year);
    }, 600);
  }

  // ── Scan ───────────────────────────────────────
  $('#scan-btn').addEventListener('click', async () => {
    const btn = $('#scan-btn');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Scanning...';
    const scanToast = showToast('Scanning library…', 'info', 0);
    if (scanToast) scanToast.querySelector('.toast-icon').innerHTML = '<svg class="toast-spin" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 1.5a6.5 6.5 0 106.5 6.5" stroke-linecap="round"/></svg>';

    try {
      const res = await fetch('/api/scan', { method: 'POST' });
      const data = await res.json();
      btn.querySelector('span').textContent = `Indexed ${data.indexed}`;
      if (scanToast) { scanToast.querySelector('.toast-icon').innerHTML = ''; scanToast.classList.remove('visible'); scanToast.remove(); }
      showToast(data.indexed > 0 ? `Indexed ${data.indexed} new item${data.indexed !== 1 ? 's' : ''}` : 'Library is up to date', 'success');
      await fetchYears();
      await selectYear(state.year);
      setTimeout(() => {
        btn.querySelector('span').textContent = 'Rescan';
        btn.disabled = false;
      }, 2000);
    } catch (err) {
      if (scanToast) { scanToast.classList.remove('visible'); scanToast.remove(); }
      showToast('Scan failed: ' + err.message, 'error');
      btn.querySelector('span').textContent = 'Rescan';
      btn.disabled = false;
    }
  });

  // ── Mobile Sidebar ─────────────────────────────
  const sidebar = $('#sidebar');
  const sidebarOverlay = $('#sidebar-overlay');

  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.hidden = false;
    requestAnimationFrame(() => sidebarOverlay.classList.add('visible'));
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('visible');
    setTimeout(() => sidebarOverlay.hidden = true, 350);
  }

  $('#mobile-menu-btn').addEventListener('click', openSidebar);
  sidebarOverlay.addEventListener('click', closeSidebar);

  $('#nav-all').addEventListener('click', () => {
    selectYear(null);
    closeSidebar();
  });

  // ── Init ───────────────────────────────────────
  initTheme();
  fetchYears().then(() => selectYear(null));
})();
