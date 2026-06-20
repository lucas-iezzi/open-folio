/* Portfolio — main.js
   Handles nav menu toggle and any site-wide interactions */

(function () {
  'use strict';

  // ── Nav hamburger toggle ──────────────────────────────────────
  const hamburger = document.getElementById('nav-hamburger');
  const menu      = document.getElementById('nav-menu');

  if (hamburger && menu) {
    function openMenu() {
      menu.classList.add('is-open');
      hamburger.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
    }

    function closeMenu() {
      menu.classList.remove('is-open');
      hamburger.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }

    hamburger.addEventListener('click', () => {
      const isOpen = hamburger.getAttribute('aria-expanded') === 'true';
      isOpen ? closeMenu() : openMenu();
    });

    // Close on link click
    menu.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', closeMenu);
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    // Close if viewport resizes large (and menu is open)
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (window.innerWidth > 900) closeMenu();
      }, 100);
    });
  }

  // ── Justified image rows (same height, fill width, no cropping) ──
  // For each multi-image section, set each img's flex-grow to its natural
  // aspect ratio (width/height). CSS flex then makes all images the same
  // height while their combined widths exactly fill the container.
  function applyJustifiedRow(row) {
    var imgs = Array.from(row.querySelectorAll('img'));
    if (imgs.length < 2) return;
    imgs.forEach(function (img) {
      function size() {
        if (img.naturalWidth > 0) {
          var ar = img.naturalWidth / img.naturalHeight;
          img.style.flex = ar + ' 1 0%';
          img.style.width = '0';
        }
      }
      if (img.complete) { size(); } else { img.addEventListener('load', size); }
    });
  }

  document.querySelectorAll('.project-section-images').forEach(applyJustifiedRow);

  // ── Secret admin shortcut: click left logo 5× in 1.5s ───────
  // Count persists via sessionStorage so it survives page navigations.
  // The 5th click is intercepted; prior clicks follow the normal href.
  (function () {
    var logo = document.querySelector('.nav-brand-icon');
    if (!logo) return;
    logo.addEventListener('click', function (e) {
      var now = Date.now();
      var stored = JSON.parse(sessionStorage.getItem('_lc') || '[0,0]');
      var count = stored[0], last = stored[1];
      if (now - last > 1500) count = 0;
      count++;
      sessionStorage.setItem('_lc', JSON.stringify([count, now]));
      if (count >= 5) {
        e.preventDefault();
        sessionStorage.removeItem('_lc');
        window.location.href = '/admin/login';
      }
    });
  }());

  // ── Lazy-load images ──────────────────────────────────────────
  if ('IntersectionObserver' in window) {
    const lazyImgs = document.querySelectorAll('img[data-src]');
    if (lazyImgs.length) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const img = entry.target;
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
            observer.unobserve(img);
          }
        });
      }, { rootMargin: '200px' });

      lazyImgs.forEach(img => observer.observe(img));
    }
  }
})();
