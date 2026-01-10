// Mobile nav toggle
const burger = document.querySelector('.burger');
const navLinks = document.querySelector('.nav-links');
if (burger && navLinks) {
  burger.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });
}

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

// Reveal animations
const revealEls = document.querySelectorAll('.reveal');
const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) entry.target.classList.add('in');
  });
}, { threshold: 0.15 });
revealEls.forEach(el => revealObserver.observe(el));

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
    revealObserver.observe(el);
  });
}

function renderList(selector, items, format) {
  const el = document.querySelector(selector);
  if (!el || !Array.isArray(items)) return;
  el.innerHTML = items.map(format).map(t => `<li>${t}</li>`).join('');
}

populateFromData();
