(function () {
  'use strict';

  const auth = firebase.auth();
  const db = firebase.firestore();

  const urlDoctorId = new URL(window.location.href).searchParams.get('doctorId');

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
    if (!user) { window.location.replace('login.php'); return; }

    const form = document.getElementById('appointment-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const slotInput = document.getElementById('slot');
      const dateInput = document.getElementById('dateInput');
      const timeSelect = document.getElementById('timeSelect');
      const reasonEl = document.getElementById('reason');
      const hiddenDoctorEl = document.getElementById('doctorIdHidden');
      const doctorNameInput = document.getElementById('doctorInput');

      // Resolve doctorId and doctorName at submit time
      let doctorId = urlDoctorId || (hiddenDoctorEl?.value || '').trim();
      let doctorName = (doctorNameInput?.value || '').trim();

      if (!doctorId && doctorName) {
        try {
          const snap = await db.collection('public_doctors').where('name', '==', doctorName).limit(1).get();
          if (!snap.empty) {
            doctorId = snap.docs[0].id;
            const d = snap.docs[0].data();
            doctorName = d.name || doctorName;
          }
        } catch {}
      }

      if (!doctorId) {
        alert('Please select a doctor first.');
        return;
      }

      // Optionally hydrate doctorName from id if still blank
      if (!doctorName) {
        try {
          const docSnap = await db.collection('public_doctors').doc(doctorId).get();
          if (docSnap.exists) doctorName = docSnap.data().name || '';
        } catch {}
      }

      let slotDate = null;
      if (slotInput && slotInput.value) {
        const d = new Date(slotInput.value);
        if (!isNaN(d.getTime())) slotDate = d;
      } else if (dateInput && timeSelect && dateInput.value && timeSelect.value) {
        slotDate = parse12hToDate(dateInput.value, timeSelect.value);
      }
      if (!slotDate || isNaN(slotDate.getTime())) {
        alert('Please select a valid date and time.');
        return;
      }

      const slotTS = firebase.firestore.Timestamp.fromDate(slotDate);

      // Deterministic document ID to prevent duplicates and avoid composite index needs
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
        alert('Appointment request sent!');
      } catch (err) {
        alert(err && err.message ? err.message : 'Failed to book appointment. Please try again.');
      }
    });
  });
})();
