(function () {
  'use strict';

  const READY_TIMEOUT_MS = 10000;

  function parse12hToDate(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    const d = new Date(`${dateStr}T00:00:00`);
    d.setHours(h, min, 0, 0);
    return d;
  }

  function waitUntil(checkFn, { timeoutMs = READY_TIMEOUT_MS, intervalMs = 50 } = {}) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      (function poll() {
        try { if (checkFn()) return resolve(true); } catch (_) {}
        if (Date.now() - start >= timeoutMs) return reject(new Error('timeout'));
        setTimeout(poll, intervalMs);
      })();
    });
  }

  async function bootstrap() {
    const form = document.getElementById('appointment-form');
    if (!form) return;

    let auth = null;
    let db = null;
    try {
      await waitUntil(() => window.firebase && firebase.apps && firebase.apps.length > 0);
      auth = firebase.auth();
      db = firebase.firestore();
    } catch (e) {
      // Attach a minimal handler to inform the user while Firebase loads (or failed)
      form.addEventListener('submit', (e2) => {
        e2.preventDefault();
        const msg = 'App is still initializing. Please refresh and try again.';
        const errorEl = form.querySelector('.error-message');
        if (errorEl) { errorEl.textContent = msg; errorEl.style.display = ''; }
        try { alert(msg); } catch (_) {}
      }, { once: true });
      return;
    }

    const urlDoctorId = new URL(window.location.href).searchParams.get('doctorId');

    function setLoading(form, on) {
      const loadingEl = form.querySelector('.loading');
      const submitBtn = form.querySelector('button[type="submit"]');
      if (loadingEl) loadingEl.style.display = on ? '' : 'none';
      if (submitBtn) submitBtn.disabled = !!on;
    }

    function showToast(message, type = 'success') {
      try {
        const hasBootstrap = !!(window.bootstrap && window.bootstrap.Toast);
        let container = document.getElementById('globalToastContainer');
        if (!container) {
          container = document.createElement('div');
          container.id = 'globalToastContainer';
          container.className = 'toast-container position-fixed top-0 end-0 p-3';
          container.style.zIndex = '1080';
          document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        const bgClass = (type === 'danger' || type === 'error')
          ? 'text-bg-danger bg-danger text-white'
          : (type === 'warning')
            ? 'text-bg-warning bg-warning'
            : (type === 'info')
              ? 'text-bg-info bg-info'
              : 'text-bg-success bg-success text-white';
        toast.className = `toast align-items-center ${bgClass} border-0`;
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'assertive');
        toast.setAttribute('aria-atomic', 'true');
        toast.innerHTML = `
          <div class="d-flex">
            <div class="toast-body">${message || ''}</div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
          </div>
        `;
        container.appendChild(toast);
        if (hasBootstrap) {
          const t = new window.bootstrap.Toast(toast, { delay: 4000 });
          t.show();
          toast.addEventListener('hidden.bs.toast', () => { toast.remove(); });
        } else {
          // Fallback simple show/hide if Bootstrap JS not present
          setTimeout(() => toast.classList.add('show'));
          setTimeout(() => { if (toast && toast.parentNode) toast.parentNode.removeChild(toast); }, 4500);
        }
      } catch (_) {
        try { alert(message); } catch (_) {}
      }
    }

    function showError(form, msg) {
      const errorEl = form.querySelector('.error-message');
      if (errorEl) { errorEl.textContent = msg || 'Something went wrong.'; errorEl.style.display = ''; }
      showToast(msg || 'Something went wrong.', 'danger');
    }

    function showSuccess(form, msg) {
      const sentEl = form.querySelector('.sent-message');
      if (sentEl) { sentEl.textContent = msg || 'Your appointment request has been sent successfully.'; sentEl.style.display = ''; }
      showToast(msg || 'Your appointment request has been sent successfully.', 'success');
    }

    function resetAlerts(form) {
      const errorEl = form.querySelector('.error-message');
      const sentEl = form.querySelector('.sent-message');
      if (errorEl) errorEl.textContent = '';
      if (sentEl) sentEl.style.display = 'none';
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!auth || !db) { showError(form, 'App not ready. Please refresh and try again.'); return; }
        const user = auth.currentUser || null;
        if (!user) { window.location.replace('login.php'); return; }

        const slotInput = document.getElementById('slot'); // optional hidden field
        const dateInput = document.getElementById('dateInput');
        const timeSelect = document.getElementById('timeSelect');
        const reasonEl = document.getElementById('reason');
        const hiddenDoctorEl = document.getElementById('doctorIdHidden');
        const doctorNameInput = document.getElementById('doctorInput');

        resetAlerts(form);
        setLoading(form, true);

        // Resolve doctor
        let doctorId = urlDoctorId || (hiddenDoctorEl?.value || '').trim();
        let doctorName = (doctorNameInput?.value || '').trim();

        try {
          if (!doctorId && doctorName) {
            const snap = await db.collection('public_doctors').where('name', '==', doctorName).limit(1).get();
            if (!snap.empty) {
              doctorId = snap.docs[0].id;
              const d = snap.docs[0].data();
              doctorName = d.name || doctorName;
            }
          }
        } catch (_) {}

        if (!doctorId) {
          setLoading(form, false);
          showError(form, 'Please select a doctor first.');
          return;
        }

        if (!doctorName) {
          try {
            const docSnap = await db.collection('public_doctors').doc(doctorId).get();
            if (docSnap.exists) doctorName = docSnap.data().name || '';
          } catch (_) {}
        }

        // Parse slot date
        let slotDate = null;
        if (slotInput && slotInput.value) {
          const d = new Date(slotInput.value);
          if (!isNaN(d.getTime())) slotDate = d;
        } else if (dateInput && timeSelect && dateInput.value && timeSelect.value) {
          slotDate = parse12hToDate(dateInput.value, timeSelect.value);
        }
        if (!slotDate || isNaN(slotDate.getTime())) {
          setLoading(form, false);
          showError(form, 'Please select a valid date and time.');
          return;
        }

        const slotTS = firebase.firestore.Timestamp.fromDate(slotDate);

        // Deterministic doc id to de-duplicate
        const docId = `${doctorId}_${slotDate.getTime()}`;
        const apptRef = db.collection('appointments').doc(docId);
        const appointmentData = {
          doctorId,
          doctorName: doctorName || '',
          patientId: user.uid,
          patientName: user.displayName || user.email || 'Patient',
          startAt: slotTS,
          status: 'pending',
          reason: reasonEl ? (reasonEl.value || '').trim() : '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        };

        try {
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(apptRef);
            if (snap.exists) {
              throw new Error('That time is already booked. Please choose another slot.');
            }
            tx.set(apptRef, appointmentData);
          });
          showSuccess(form, 'Your appointment request has been sent successfully.');
        } catch (err) {
          console.error('[appointment] booking error:', err);
          showError(form, err && err.message ? err.message : 'Failed to book appointment. Please try again.');
        } finally {
          setLoading(form, false);
        }
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
