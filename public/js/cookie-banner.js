/* Privacy banner + privacy notice modal */

(function () {
  'use strict';

  // Remembered per browser: once dismissed, the banner never shows again here.
  var ACK_KEY = 'of_cookie_ack';

  var banner   = document.getElementById('cookie-banner');
  var dismiss  = document.getElementById('cookie-banner-close');
  var modal    = document.getElementById('privacy-modal');
  var closeBtn = document.getElementById('privacy-modal-close');
  var backdrop = document.getElementById('privacy-modal-backdrop');

  if (banner) {
    var acknowledged = false;
    try { acknowledged = localStorage.getItem(ACK_KEY) === '1'; } catch (e) { /* storage unavailable */ }
    if (!acknowledged) banner.hidden = false;

    if (dismiss) {
      dismiss.addEventListener('click', function () {
        try { localStorage.setItem(ACK_KEY, '1'); } catch (e) { /* storage unavailable */ }
        banner.hidden = true;
      });
    }
  }

  if (!modal) return;

  var opener = null;

  function openModal(e) {
    opener = e.currentTarget;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
    if (opener) opener.focus();
  }

  document.querySelectorAll('[data-open-privacy]').forEach(function (btn) {
    btn.addEventListener('click', openModal);
  });
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (backdrop) backdrop.addEventListener('click', closeModal);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });
})();
