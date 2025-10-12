(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof window.firebase === 'undefined') return;

  const auth = firebase.auth();
  const db = firebase.firestore();

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

  auth.onAuthStateChanged(async (user) => {
    if (!user) return; // Allow page guard elsewhere

    const form = document.getElementById('appointment-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const dateInput = document.getElementById('dateInput');
      const timeSelect = document.getElementById('timeSelect');
      const hiddenDoctorEl = document.getElementById('doctorIdHidden');
      const doctorNameInput = document.getElementById('doctorInput');
      const reasonEl = document.getElementById('reason');

      const loadingEl = form.querySelector('.loading');
      const errorEl = form.querySelector('.error-message');
      const sentEl = form.querySelector('.sent-message');

      function setLoading(on) {
        if (loadingEl) loadingEl.style.display = on ? '' : 'none';
        if (errorEl) errorEl.textContent = '';
        if (sentEl) sentEl.style.display = 'none';
      }

      setLoading(true);

      try {
        let doctorId = (hiddenDoctorEl && hiddenDoctorEl.value) ? hiddenDoctorEl.value.trim() : '';
        let doctorName = (doctorNameInput && doctorNameInput.value) ? doctorNameInput.value.trim() : '';

        if (!doctorId) {
          if (doctorName) {
            const snap = await db.collection('public_doctors').where('name', '==', doctorName).limit(1).get();
            if (!snap.empty) doctorId = snap.docs[0].id;
          }
        }

        if (!doctorId) {
          throw new Error('Please select a doctor.');
        }

        const dateStr = dateInput && dateInput.value ? dateInput.value : '';
        const timeStr = timeSelect && timeSelect.value ? timeSelect.value : '';
        const slotDate = parse12hToDate(dateStr, timeStr);
        if (!slotDate || isNaN(slotDate.getTime())) {
          throw new Error('Please select a valid date and time.');
        }

        const slotTS = firebase.firestore.Timestamp.fromDate(slotDate);

        // Prevent double booking
        const existing = await db.collection('appointments')
          .where('doctorId', '==', doctorId)
          .where('startAt', '==', slotTS)
          .limit(1)
          .get();
        if (!existing.empty) {
          throw new Error('That time is already booked. Please choose another slot.');
        }

        // Fetch doctor name if missing
        if (!doctorName) {
          try {
            const docSnap = await db.collection('public_doctors').doc(doctorId).get();
            if (docSnap.exists) doctorName = (docSnap.data() || {}).name || '';
          } catch (_) {}
        }

        await db.collection('appointments').add({
          doctorId,
          doctorName: doctorName || '',
          patientId: user.uid,
          patientName: user.displayName || user.email || 'Patient',
          startAt: slotTS,
          status: 'pending',
          reason: reasonEl ? (reasonEl.value || '').trim() : '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });

        if (sentEl) sentEl.style.display = '';
        form.reset();
        // Preserve doctor selection after reset
        if (hiddenDoctorEl) hiddenDoctorEl.value = doctorId;
        if (doctorNameInput) doctorNameInput.value = doctorName || doctorId;
      } catch (err) {
        if (errorEl) errorEl.textContent = err && err.message ? err.message : 'Failed to book appointment.';
      } finally {
        setLoading(false);
      }
    });
  });
})();
