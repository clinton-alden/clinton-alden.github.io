// Mobile nav toggle
const burger = document.querySelector('.burger');
const navLinks = document.querySelector('.nav-links');

// Tool and content pages begin at their navigation while keeping the banner above.
if (document.body.classList.contains('skip-banner-on-load') && !window.location.hash) {
  const bannerImage = document.querySelector('.banner-image');
  const header = document.querySelector('.header');
  const scrollPastBanner = () => {
    if (!header) return;
    window.scrollTo(0, Math.round(header.getBoundingClientRect().top + window.scrollY));
  };

  if (bannerImage?.complete && bannerImage.naturalWidth) {
    requestAnimationFrame(scrollPastBanner);
  } else {
    bannerImage?.addEventListener('load', () => requestAnimationFrame(scrollPastBanner), { once: true });
  }
}

if (burger && navLinks) {
  burger.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });
}

const navToolMenus = document.querySelectorAll('.nav-tools');
document.addEventListener('click', event => {
  navToolMenus.forEach(menu => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') navToolMenus.forEach(menu => { menu.open = false; });
});

// Smooth scroll for anchor links
const links = document.querySelectorAll('a[href^="#"]');
links.forEach(link => {
  link.addEventListener('click', e => {
    const targetId = link.getAttribute('href').slice(1);
    const target = document.getElementById(targetId);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (navLinks) navLinks.classList.remove('open');
    }
  });
});

// Scrollspy: highlight active nav link
const sections = document.querySelectorAll('section[id]');
if (typeof IntersectionObserver !== 'undefined') {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const id = entry.target.getAttribute('id');
      const navLink = document.querySelector(`.nav-links a[href="#${id}"]`);
      if (!navLink) return;
      if (entry.isIntersecting) {
        document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
        navLink.classList.add('active');
      }
    });
  }, { rootMargin: '-40% 0px -50% 0px', threshold: 0.25 });
  sections.forEach(sec => observer.observe(sec));
}

// Reveal animations
const revealEls = document.querySelectorAll('.reveal');
let revealObserver = null;
if (typeof IntersectionObserver !== 'undefined') {
  revealObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) entry.target.classList.add('in');
    });
  }, { threshold: 0.15 });
  revealEls.forEach(el => revealObserver.observe(el));
} else {
  revealEls.forEach(el => el.classList.add('in'));
}

// Dynamic year in footer
const yearEl = document.querySelector('#year');
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Populate content from assets/data.json if present
async function populateFromData() {
  try {
    const res = await fetch('assets/data.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();

    // Summary on index and CV
    if (data.summary) {
      const summaryEl = document.querySelector('#summary');
      if (summaryEl) summaryEl.textContent = data.summary;
      const cvSummaryEl = document.querySelector('#cv-summary');
      if (cvSummaryEl) cvSummaryEl.textContent = data.summary;
    }

    // Experience lists
    renderExperience('#experience-list', data.experience);
    renderExperience('#cv-experience-list', data.experience);

    // Education (CV page)
    if (Array.isArray(data.education)) {
      const eduEl = document.querySelector('#cv-education-list');
      if (eduEl) {
        eduEl.innerHTML = '';
        data.education.forEach(item => {
          const li = document.createElement('li');
          const parts = [item.degree, item.field].filter(Boolean).join(' in ');
          li.textContent = `${parts} — ${item.institution}`;
          eduEl.appendChild(li);
        });
      }
    }

    // Contact info
    if (data.contact) {
      const emailLink = document.querySelector('#contact-email-link');
      if (emailLink && data.contact.email) {
        emailLink.href = `mailto:${data.contact.email}`;
      }
      const locEl = document.querySelector('#contact-location');
      if (locEl && data.contact.location) {
        locEl.textContent = data.contact.location;
      }
      const phoneEl = document.querySelector('#contact-phone');
      if (phoneEl && data.contact.phone) {
        const tel = data.contact.phone.replace(/[^\d+]/g, '');
        phoneEl.innerHTML = `<a href="tel:${tel}">${data.contact.phone}</a>`;
      }
    }

    // Presentations
    renderList('#cv-presentations', data.presentations, item => `${item.date} — ${item.organization}: ${item.title}`);

    // Awards
    renderList('#cv-awards', data.awards, item => `${item.name}${item.year ? ' — ' + item.year : ''}`);

    // Memberships
    renderList('#cv-memberships', data.memberships, item => `${item.organization} — ${item.role}${item.period ? ' (' + item.period + ')' : ''}`);

    // Skills
    renderList('#cv-skills', data.skills, s => s);

    // Certifications & Training
    renderList('#cv-certifications', data.certifications, item => `${item.name}${item.date ? ' — ' + item.date : ''}`);

    // Media Outreach
    renderList('#cv-media', data.media, item => `${item.date} — ${item.outlet}: ${item.title}`);
  } catch (e) {
    // Silent fail if no data.json; keep static content
  }
}

function renderExperience(selector, items) {
  const container = document.querySelector(selector);
  if (!container || !Array.isArray(items)) return;
  container.innerHTML = '';
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'timeline-item reveal';
    const meta = [item.period, item.title, item.location].filter(Boolean).join(' · ');
    el.innerHTML = `
      <div class="meta">${meta}</div>
      <h3>${item.company || ''}</h3>
      ${Array.isArray(item.bullets) ? `<ul>${item.bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : `<p>${item.description || ''}</p>`}
    `;
    container.appendChild(el);
    if (revealObserver) revealObserver.observe(el);
  });
}

function renderList(selector, items, format) {
  const el = document.querySelector(selector);
  if (!el || !Array.isArray(items)) return;
  el.innerHTML = items.map(format).map(t => `<li>${t}</li>`).join('');
}

function initAdventureSkiLines() {
  if (window.__skiLinesInitialized) return;
  const dataEl = document.getElementById('ski-lines-data');
  const listEl = document.getElementById('ski-line-list');
  const mapEl = document.getElementById('ski-leaflet-map');
  const fallbackMapEl = document.getElementById('ski-fallback-map');
  const fallbackMarkersEl = document.getElementById('ski-fallback-markers');
  const captionEl = document.getElementById('ski-map-caption');
  const totalEl = document.getElementById('ski-lines-total');
  const statesEl = document.getElementById('ski-lines-states');
  const couloirsEl = document.getElementById('ski-lines-couloirs');
  const progressEl = document.getElementById('ski-progress-fill');

  // Prefer local interactive SVG map for reliability across blocked tile servers.
  if (mapEl) mapEl.classList.add('is-hidden');
  if (fallbackMapEl) fallbackMapEl.classList.add('is-visible');

  if (!dataEl || !listEl) {
    console.error('Missing core adventure ski lines elements');
    return;
  }

  window.__skiLinesInitialized = true;

  let skiLines;
  try {
    skiLines = JSON.parse(dataEl.textContent);
  } catch (error) {
    return;
  }

  if (!Array.isArray(skiLines) || skiLines.length === 0) return;

  // Sort lines by date (newest first), with undated at bottom
  skiLines.sort((a, b) => {
    const aHasDate = a.date && a.date.trim();
    const bHasDate = b.date && b.date.trim();
    
    // If both have dates, sort by date (newest first)
    if (aHasDate && bHasDate) {
      const aDate = new Date(a.date);
      const bDate = new Date(b.date);
      return bDate - aDate;
    }
    
    // If only b has a date, b comes first
    if (bHasDate) return 1;
    
    // If only a has a date, a comes first
    if (aHasDate) return -1;
    
    // If neither has a date, maintain original order
    return 0;
  });

  const markerStates = [];
  const listNodes = [];

  const total = skiLines.length;
  const uniqueStates = new Set(skiLines.map(line => line.state)).size;
  const couloirCount = skiLines.filter(line => line.style === 'Couloir').length;

  if (totalEl) totalEl.textContent = String(total);
  if (statesEl) statesEl.textContent = String(uniqueStates);
  if (couloirsEl) couloirsEl.textContent = String(couloirCount);
  if (progressEl) progressEl.style.width = '100%';

  let map = null;
  let usedFallback = false;

  function projectPoint(lat, lon) {
    const bounds = {
      width: 620,
      height: 430,
      paddingX: 80,
      paddingY: 40,
      west: -125,
      east: -110,
      south: 32,
      north: 49.5
    };

    const usableWidth = bounds.width - bounds.paddingX * 2;
    const usableHeight = bounds.height - bounds.paddingY * 2;
    const x = bounds.paddingX + ((lon - bounds.west) / (bounds.east - bounds.west)) * usableWidth;
    const y = bounds.paddingY + (1 - (lat - bounds.south) / (bounds.north - bounds.south)) * usableHeight;
    return { x, y };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function buildFallbackMarkers() {
    usedFallback = true;
    mapEl.classList.add('is-hidden');
    fallbackMapEl.classList.add('is-visible');
    fallbackMarkersEl.innerHTML = '';

    const svgNs = 'http://www.w3.org/2000/svg';
    const basePoints = skiLines.map(line => projectPoint(line.lat, line.lon));
    const adjustedPoints = basePoints.map(point => ({ x: point.x, y: point.y }));
    const minSpacing = 28;
    const angleStep = Math.PI / 3;

    adjustedPoints.forEach((point, index) => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const overlaps = adjustedPoints.slice(0, index).some(other => {
          const dx = point.x - other.x;
          const dy = point.y - other.y;
          return Math.hypot(dx, dy) < minSpacing;
        });

        if (!overlaps) return;

        const distance = 12 + attempt * 4;
        const angle = (index + attempt) * angleStep;
        point.x = clamp(basePoints[index].x + Math.cos(angle) * distance, 92, 528);
        point.y = clamp(basePoints[index].y + Math.sin(angle) * distance, 52, 368);
      }
    });

    skiLines.forEach((line, index) => {
      const point = adjustedPoints[index];
      const marker = document.createElementNS(svgNs, 'g');
      marker.setAttribute('class', 'fallback-marker');
      marker.setAttribute('transform', `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`);
      marker.setAttribute('tabindex', '0');
      marker.setAttribute('role', 'button');
      marker.setAttribute('aria-label', `${line.name}, ${line.area}, ${line.state}`);

      const ring = document.createElementNS(svgNs, 'circle');
      ring.setAttribute('class', 'fallback-marker-ring');
      ring.setAttribute('r', '16');

      const dot = document.createElementNS(svgNs, 'circle');
      dot.setAttribute('class', 'fallback-marker-dot');
      dot.setAttribute('r', '6.5');

      const label = document.createElementNS(svgNs, 'text');
      label.setAttribute('class', 'fallback-marker-label');
      label.setAttribute('y', '1');
      label.textContent = String(index + 1);

      marker.addEventListener('mouseenter', () => setActive(index));
      marker.addEventListener('focus', () => setActive(index));
      marker.addEventListener('click', () => setActive(index));

      marker.appendChild(ring);
      marker.appendChild(dot);
      marker.appendChild(label);
      fallbackMarkersEl.appendChild(marker);

      markerStates.push({
        setActive: isActive => marker.classList.toggle('is-active', isActive),
        focus: () => {}
      });
    });
  }

  function tryLeafletMap() {
    if (typeof L === 'undefined') return false;

    try {
      mapEl.classList.remove('is-hidden');
      fallbackMapEl.classList.remove('is-visible');

      map = L.map(mapEl, {
        zoomControl: true,
        scrollWheelZoom: true,
        minZoom: 3,
        maxZoom: 14
      });

      const topoLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          attribution: 'Tiles &copy; Esri'
        }
      );

      const esriTopoLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
        {
          attribution: 'Tiles &copy; Esri'
        }
      );

      const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
      });

      topoLayer.addTo(map);

      // If OpenTopoMap is blocked/rate-limited, fall back to Esri topo tiles.
      let switchedToEsri = false;
      let switchedToOsm = false;
      let hasLoadedAnyTile = false;

      topoLayer.on('tileload', () => { hasLoadedAnyTile = true; });
      esriTopoLayer.on('tileload', () => { hasLoadedAnyTile = true; });
      osmLayer.on('tileload', () => { hasLoadedAnyTile = true; });

      topoLayer.on('tileerror', () => {
        if (switchedToEsri) return;
        switchedToEsri = true;
        map.removeLayer(topoLayer);
        esriTopoLayer.addTo(map);
      });

      esriTopoLayer.on('tileerror', () => {
        if (switchedToOsm) return;
        switchedToOsm = true;
        if (map.hasLayer(esriTopoLayer)) map.removeLayer(esriTopoLayer);
        osmLayer.addTo(map);
      });

      const latLngs = skiLines.map(line => [line.lat, line.lon]);
      const bounds = L.latLngBounds(latLngs);
      map.fitBounds(bounds.pad(0.35));
      setTimeout(() => map.invalidateSize(), 200);

      skiLines.forEach((line, index) => {
        const dotEl = document.createElement('div');
        dotEl.className = 'ski-map-dot';

        const icon = L.divIcon({
          className: '',
          html: dotEl.outerHTML,
          iconSize: [18, 18],
          iconAnchor: [9, 9]
        });

        const marker = L.marker([line.lat, line.lon], { icon }).addTo(map);
        marker.bindPopup(`<strong>${line.name}</strong>`);
        marker.on('mouseover', () => setActive(index));
        marker.on('focus', () => setActive(index));
        marker.on('click', () => setActive(index));

        const markerElement = marker.getElement();
        const markerDot = markerElement ? markerElement.querySelector('.ski-map-dot') : null;

        markerStates.push({
          setActive: isActive => {
            if (markerDot) markerDot.classList.toggle('is-active', isActive);
            if (isActive) marker.openPopup();
          },
          focus: () => marker.openPopup()
        });
      });

      // If absolutely no provider loads tiles, switch to local SVG fallback.
      setTimeout(() => {
        if (usedFallback) return;
        if (!hasLoadedAnyTile) {
          if (map) map.remove();
          map = null;
          markerStates.length = 0;
          buildFallbackMarkers();
          setActive(0);
        }
      }, 8000);

      return true;
    } catch (error) {
      if (map) map.remove();
      map = null;
      markerStates.length = 0;
      return false;
    }
  }

  function updateGallery(line) {
    const galleryEl = document.getElementById('ski-lines-gallery');
    if (!galleryEl) return;
    
    galleryEl.innerHTML = '';
    
    // Only populate gallery if this line has images
    if (!line.images || !Array.isArray(line.images) || line.images.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.innerHTML = `<p>No photos added yet for ${line.name}.</p>`;
      galleryEl.appendChild(empty);
      return;
    }
    
    line.images.forEach((imageSrc) => {
      const item = document.createElement('div');
      item.className = 'gallery-item reveal';
      item.innerHTML = `
        <img src="${imageSrc}" alt="${line.name}" class="gallery-image" />
        <p style="margin-top: 16px; font-size: 14px; color: var(--muted);">${line.area}, ${line.state}</p>
      `;
      galleryEl.appendChild(item);
    });
  }

  function setActive(index) {
    skiLines.forEach((line, currentIndex) => {
      const isActive = currentIndex === index;
      const markerState = markerStates[currentIndex];
      const listNode = listNodes[currentIndex];
      if (markerState) {
        markerState.setActive(isActive);
      }
      if (listNode) {
        listNode.classList.toggle('is-active', isActive);
        listNode.setAttribute('aria-pressed', String(isActive));
      }

      if (isActive && captionEl) {
        const dateSuffix = line.date ? ` - ${line.date}` : '';
        captionEl.textContent = `${line.name} - ${line.area}, ${line.state} - ${line.style}${dateSuffix}`;
      }
    });

    const selected = skiLines[index];
    if (selected) {
      updateGallery(selected);
      if (map && !usedFallback) {
        map.flyTo([selected.lat, selected.lon], Math.max(map.getZoom(), 7), { duration: 0.6 });
      }
    }
  }

  skiLines.forEach((line, index) => {
    const listItem = document.createElement('button');
    listItem.type = 'button';
    listItem.className = 'ski-line-item';
    listItem.setAttribute('aria-label', `${line.name}, ${line.area}, ${line.state}`);
    listItem.innerHTML = `
      <div class="ski-line-item-top">
        <div>
          <p class="ski-line-item-name">${line.name}</p>
          <span class="ski-line-meta">${line.area}, ${line.state}</span>
        </div>
        <span class="ski-line-check">[x]</span>
      </div>
      <span class="ski-line-style">${line.style}</span>
      ${line.date ? `<span class="ski-line-date">${line.date}</span>` : ''}
    `;
    listItem.addEventListener('mouseenter', () => setActive(index));
    listItem.addEventListener('focus', () => setActive(index));
    listItem.addEventListener('click', () => setActive(index));
    listEl.appendChild(listItem);
    listNodes.push(listItem);
  });

  if (mapEl && fallbackMapEl && fallbackMarkersEl) {
    buildFallbackMarkers();
  }

  setActive(0);
}

function emergencyRenderSkiLines() {
  const dataEl = document.getElementById('ski-lines-data');
  const listEl = document.getElementById('ski-line-list');
  const fallbackMapEl = document.getElementById('ski-fallback-map');
  const fallbackMarkersEl = document.getElementById('ski-fallback-markers');
  const mapEl = document.getElementById('ski-leaflet-map');
  const galleryEl = document.getElementById('ski-lines-gallery');
  const captionEl = document.getElementById('ski-map-caption');

  if (!dataEl || !listEl || !fallbackMapEl || !fallbackMarkersEl) return;
  if (listEl.children.length > 0) return;

  let skiLines;
  try {
    skiLines = JSON.parse(dataEl.textContent);
  } catch (error) {
    return;
  }
  if (!Array.isArray(skiLines) || skiLines.length === 0) return;

  if (mapEl) mapEl.classList.add('is-hidden');
  fallbackMapEl.classList.add('is-visible');
  fallbackMarkersEl.innerHTML = '';
  listEl.innerHTML = '';

  const svgNs = 'http://www.w3.org/2000/svg';
  const mapBounds = { width: 620, height: 430, paddingX: 80, paddingY: 40, west: -125, east: -110, south: 32, north: 49.5 };

  function projectPoint(lat, lon) {
    const usableWidth = mapBounds.width - mapBounds.paddingX * 2;
    const usableHeight = mapBounds.height - mapBounds.paddingY * 2;
    return {
      x: mapBounds.paddingX + ((lon - mapBounds.west) / (mapBounds.east - mapBounds.west)) * usableWidth,
      y: mapBounds.paddingY + (1 - (lat - mapBounds.south) / (mapBounds.north - mapBounds.south)) * usableHeight
    };
  }

  function renderGallery(line) {
    if (!galleryEl) return;
    galleryEl.innerHTML = '';
    if (!line.images || !Array.isArray(line.images) || line.images.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.innerHTML = `<p>No photos added yet for ${line.name}.</p>`;
      galleryEl.appendChild(empty);
      return;
    }
    line.images.forEach(src => {
      const item = document.createElement('div');
      item.className = 'gallery-item reveal in';
      item.innerHTML = `<img src="${src}" alt="${line.name}" class="gallery-image" /><p style="margin-top: 16px; font-size: 14px; color: var(--muted);">${line.area}, ${line.state}</p>`;
      galleryEl.appendChild(item);
    });
  }

  function setActive(index) {
    const nodes = listEl.querySelectorAll('.ski-line-item');
    nodes.forEach((node, i) => node.classList.toggle('is-active', i === index));
    const markerNodes = fallbackMarkersEl.querySelectorAll('.fallback-marker');
    markerNodes.forEach((node, i) => node.classList.toggle('is-active', i === index));
    const line = skiLines[index];
    if (captionEl && line) {
      const dateSuffix = line.date ? ` - ${line.date}` : '';
      captionEl.textContent = `${line.name} - ${line.area}, ${line.state} - ${line.style}${dateSuffix}`;
    }
    if (line) renderGallery(line);
  }

  skiLines.forEach((line, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ski-line-item';
    btn.innerHTML = `<div class="ski-line-item-top"><div><p class="ski-line-item-name">${line.name}</p><span class="ski-line-meta">${line.area}, ${line.state}</span></div><span class="ski-line-check">[x]</span></div><span class="ski-line-style">${line.style}</span>${line.date ? `<span class="ski-line-date">${line.date}</span>` : ''}`;
    btn.addEventListener('mouseenter', () => setActive(index));
    btn.addEventListener('focus', () => setActive(index));
    btn.addEventListener('click', () => setActive(index));
    listEl.appendChild(btn);

    const point = projectPoint(line.lat, line.lon);
    const marker = document.createElementNS(svgNs, 'g');
    marker.setAttribute('class', 'fallback-marker');
    marker.setAttribute('transform', `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`);
    marker.innerHTML = `<circle class="fallback-marker-ring" r="16"></circle><circle class="fallback-marker-dot" r="6.5"></circle><text class="fallback-marker-label" y="1">${index + 1}</text>`;
    marker.addEventListener('mouseenter', () => setActive(index));
    marker.addEventListener('focus', () => setActive(index));
    marker.addEventListener('click', () => setActive(index));
    fallbackMarkersEl.appendChild(marker);
  });

  setActive(0);
}

populateFromData();
if (!window.__USE_INLINE_SKI_LINES__) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdventureSkiLines, { once: true });
  } else {
    initAdventureSkiLines();
  }

  setTimeout(() => {
    const listEl = document.getElementById('ski-line-list');
    if (!listEl || listEl.children.length > 0) return;
    emergencyRenderSkiLines();
  }, 250);
}
