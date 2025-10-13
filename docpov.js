(function(){
  const state = { user: null, profile: null, unsubscribeAppointments: null };

  function qs(id){ return document.getElementById(id); }
  function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstChild; }
  function fmt(ts){ if (!ts) return ''; const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleString(); }
  function withDrPrefix(name){
    if (!name) return '';
    const n = name.trim();
    return n.toLowerCase().startsWith('dr.') ? n : `Dr. ${n}`;
  }
  function toDateObj(ts){ return ts && ts.toDate ? ts.toDate() : (ts ? new Date(ts) : null); }
  function statusBadge(status){
    const s = (status || 'pending').toLowerCase();
    const cls = s === 'confirmed' || s === 'done' ? 'bg-success'
      : (s === 'cancelled' || s === 'rejected') ? 'bg-danger'
      : s === 'rescheduled' ? 'bg-warning text-dark'
      : 'bg-secondary';
    return `<span class="badge rounded-pill ${cls}">${s}</span>`;
  }

  function guardAuth(){
    auth.onAuthStateChanged(async (user)=>{
      // Cleanup any previous appointment listener
      if (typeof state.unsubscribeAppointments === 'function') {
        try { state.unsubscribeAppointments(); } catch(_) {}
        state.unsubscribeAppointments = null;
      }

      if (!user) { window.location.href = './doclogin.php'; return; }

      // Doctor-only guard using users/{uid}.role with fallback to doctors/{uid}
      try {
        const [userDoc, doctorDoc] = await Promise.all([
          db.collection('users').doc(user.uid).get(),
          db.collection('doctors').doc(user.uid).get()
        ]);
        const role = userDoc.exists ? userDoc.data().role : null;
        const isDoctor = role === 'doctor' || doctorDoc.exists;
        if (!isDoctor) {
          await auth.signOut().catch(()=>{});
          window.location.href = './doclogin.php';
          return;
        }
      } catch {
        await auth.signOut().catch(()=>{});
        window.location.href = './doclogin.php';
        return;
      }

      state.user = user;
      if (qs('headerName')) qs('headerName').textContent = user.displayName || user.email;
      await loadProfile(user.uid);
      wireNav();
      loadAppointments();
      loadPatients();
    });
  }

  async function loadProfile(uid){
    const snap = await db.collection('doctors').doc(uid).get();
    state.profile = snap.exists ? snap.data() : null;
    const p = state.profile || {};
    const displayName = withDrPrefix(p.fullName) || (state.user.displayName || 'Doctor');

    const nameEl = qs('doc-name'); if (nameEl) nameEl.textContent = displayName;
    const specEl = qs('doc-specialty'); if (specEl) specEl.textContent = p.specialty || 'Specialty';
    const avatarEl = qs('avatar'); if (avatarEl) {
      const initials = (p.fullName || 'Dr').split(' ').map(s=>s[0]).join('').substring(0,2).toUpperCase();
      avatarEl.textContent = initials;
    }

    // Fill form fields only if present on this page
    const nameInp = qs('profile-name'); if (nameInp) nameInp.value = p.fullName || '';
    const specInp = qs('profile-specialty'); if (specInp) specInp.value = p.specialty || '';
    const phoneInp = qs('profile-contact'); if (phoneInp) phoneInp.value = p.phone || '';
    const emailInp = qs('profile-email'); if (emailInp) { emailInp.value = state.user.email || ''; emailInp.disabled = true; }
    const aboutInp = qs('profile-about'); if (aboutInp) aboutInp.value = p.about || '';

    await ensurePublicProfile(uid, p, displayName);
  }

  async function ensurePublicProfile(uid, p, displayName){
    try {
      const publicRef = db.collection('public_doctors').doc(uid);
      const pubSnap = await publicRef.get();
      if (!pubSnap.exists) {
        await publicRef.set({
          name: displayName || withDrPrefix(p.fullName) || 'Doctor',
          specialty: p.specialty || '',
          image: p.avatarUrl || 'assets/img/health/doctor-placeholder.webp',
          bio: p.about || '',
          schedule: Array.isArray(p.schedule) ? p.schedule : [],
          reviewsCount: 0,
          isListed: true,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    } catch (err) {
      console.error('ensurePublicProfile failed', err);
    }
  }

  async function syncPublicProfile(uid, updates){
    try {
      const publicRef = db.collection('public_doctors').doc(uid);
      const prevSnap = await publicRef.get();
      const prev = prevSnap.exists ? prevSnap.data() : {};
      const displayName =
        withDrPrefix(updates.fullName) ||
        withDrPrefix(state.profile?.fullName) ||
        (state.user.displayName || 'Doctor');

      await publicRef.set({
        name: displayName,
        specialty: updates.specialty || prev.specialty || '',
        image: prev.image || 'assets/img/health/doctor-placeholder.webp',
        bio: updates.about || prev.bio || '',
        schedule: Array.isArray(prev.schedule) ? prev.schedule : [],
        reviewsCount: typeof prev.reviewsCount === 'number' ? prev.reviewsCount : 0,
        isListed: typeof prev.isListed === 'boolean' ? prev.isListed : true,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (err) {
      console.error('syncPublicProfile failed', err);
    }
  }

  async function saveProfile(e){
    e.preventDefault();
    const updates = {
      fullName: qs('profile-name')?.value?.trim() || '',
      specialty: qs('profile-specialty')?.value?.trim() || '',
      phone: qs('profile-contact')?.value?.trim() || '',
      about: qs('profile-about')?.value?.trim() || '',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    const uid = state.user.uid;

    await db.collection('doctors').doc(uid).set(
      { uid, email: state.user.email, role: 'doctor', ...updates },
      { merge: true }
    );

    await syncPublicProfile(uid, updates);
    await loadProfile(uid);
    toast('Profile saved');
  }

  function resetProfile(){ loadProfile(state.user.uid); }

  function wireNav(){
    document.querySelectorAll('[data-section]').forEach(btn => {
      btn.addEventListener('click', ()=> showSection(btn.getAttribute('data-section')));
    });
    document.querySelectorAll('#navmenu a.nav-link').forEach(a => {
      a.addEventListener('click', (e)=>{ e.preventDefault(); showSection(a.getAttribute('data-section')); document.querySelectorAll('#navmenu a').forEach(x=>x.classList.remove('active')); a.classList.add('active'); });
    });
    qs('profile-form')?.addEventListener('submit', saveProfile);
    qs('profile-reset')?.addEventListener('click', resetProfile);
    if (qs('logoutBtn')) qs('logoutBtn').addEventListener('click', async ()=>{ await auth.signOut(); window.location.href='./doclogin.php'; });
  }

  function showSection(id){
    ['appointments','patients','profile'].forEach(sec=>{
      const el = qs('section-' + sec);
      if (el) el.style.display = (sec===id) ? '' : 'none';
    });
    document.querySelectorAll('[data-section]').forEach(b=> b.classList.toggle('active', b.getAttribute('data-section')===id));
  }

  function toast(msg){
    const t = el(`<div class="toast align-items-center text-bg-dark border-0" role="alert" aria-live="assertive" aria-atomic="true" style="position:fixed;bottom:20px;right:20px;z-index:1080"><div class="d-flex"><div class="toast-body">${msg}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div></div>`);
    document.body.appendChild(t);
    const bsToast = new bootstrap.Toast(t, { delay: 2000 });
    bsToast.show();
    t.addEventListener('hidden.bs.toast', ()=> t.remove());
  }

  async function loadAppointments(){
    const uid = state.user.uid;
    const listUpcoming = qs('appointments-upcoming');
    const listPast = qs('appointments-past');

    if (listUpcoming) listUpcoming.innerHTML = '<div class="text-muted small px-2">Loading…</div>';
    if (listPast) listPast.innerHTML = '';

    // Cleanup previous listener if any
    if (typeof state.unsubscribeAppointments === 'function') {
      try { state.unsubscribeAppointments(); } catch(_) {}
      state.unsubscribeAppointments = null;
    }

    try {
      // Equality filter only; we'll sort client-side to avoid composite index requirement
      const query = db.collection('appointments').where('doctorId','==',uid);

      state.unsubscribeAppointments = query.onSnapshot(
        (snap) => {
          if (listUpcoming) listUpcoming.innerHTML = '';
          if (listPast) listPast.innerHTML = '';

          if (!snap || snap.empty) {
            if (listUpcoming) listUpcoming.innerHTML = '<div class="list-group-item">No upcoming appointments</div>';
            return;
          }

          const nowMs = Date.now();
          const items = [];
          snap.forEach(doc => { items.push({ id: doc.id, ...doc.data() }); });

          items.sort((a,b)=>{
            const at = toDateObj(a.startAt)?.getTime() ?? 0;
            const bt = toDateObj(b.startAt)?.getTime() ?? 0;
            return at - bt;
          });

          for (const a of items) {
            const when = toDateObj(a.startAt);
            const statusLower = (a.status || '').toLowerCase();
            const isDone = statusLower === 'done';
            const isPast = isDone || (when ? when.getTime() < nowMs : false);
            const roomLink = a.roomId ? `./index.html?room=${encodeURIComponent(a.roomId)}` : './index.html';

            const item = el(`<div class="list-group-item d-flex justify-content-between align-items-center appt-card">
              <div>
                <div class="fw-semibold d-flex align-items-center gap-2">
                  <span>${a.patientName || 'Patient'}</span>
                  ${statusBadge(a.status)}
                </div>
                <div class="text-muted small">${fmt(a.startAt)}${a.reason ? ` • ${a.reason}` : ''}</div>
              </div>
              <div class="d-flex gap-2">
                <a href="${roomLink}" class="btn btn-sm btn-primary">${a.roomId ? 'Join call' : 'Open meeting'}</a>
              </div>
            </div>`);

            // Add Done button for upcoming appointments
            if (!isPast) {
              const actions = item.querySelector('.d-flex.gap-2');
              if (actions) {
                const doneBtn = el(`<button class="btn btn-sm btn-outline-success mark-done-btn" data-id="${a.id}" ${statusLower === 'done' ? 'disabled' : ''}>
                  <i class="bi bi-check-lg"></i> Done
                </button>`);
                actions.appendChild(doneBtn);
                doneBtn.addEventListener('click', async ()=>{
                  if (doneBtn.disabled) return;
                  doneBtn.disabled = true;
                  const original = doneBtn.innerHTML;
                  doneBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
                  try {
                    await db.collection('appointments').doc(String(a.id)).update({
                      status: 'done',
                      completedAt: firebase.firestore.FieldValue.serverTimestamp(),
                      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    toast('Appointment marked as done');
                  } catch (err) {
                    console.error('mark done failed', err);
                    doneBtn.disabled = false;
                    doneBtn.innerHTML = original;
                    toast('Failed to mark as done: ' + (err?.message || ''));
                  }
                });
              }
            }

            (isPast ? listPast : listUpcoming).appendChild(item);
          }

          if (listPast && !listPast.children.length) listPast.innerHTML = '<div class="list-group-item">No past appointments</div>';
        },
        (err) => {
          console.error('appointments listener error', err);
          if (listUpcoming) listUpcoming.innerHTML = '<div class="list-group-item text-danger">Failed to load appointments</div>';
        }
      );
    } catch (err) {
      console.error('loadAppointments failed', err);
      if (listUpcoming) listUpcoming.innerHTML = '<div class="list-group-item text-danger">Failed to load appointments</div>';
    }
  }

  async function loadPatients(){
    const uid = state.user.uid;
    const list = qs('patients-list');
    if (list) list.innerHTML = '<div class="text-muted small px-2">Loading…</div>';
    const snap = await db.collection('patients').where('doctorId','==',uid).limit(25).get().catch(()=>null);
    if (!list) return;
    list.innerHTML = '';
    if (!snap || snap.empty) { list.innerHTML = '<div class="list-group-item">No patients yet</div>'; return; }
    snap.forEach(doc => {
      const p = doc.data();
      list.appendChild(el(`<div class="list-group-item d-flex justify-content-between align-items-center">
        <div>
          <div class="fw-semibold">${p.fullName || 'Patient'}</div>
          <div class="text-muted small">${p.email || ''}</div>
        </div>
        <a class="btn btn-sm btn-outline-primary" href="#">View</a>
      </div>`));
    });
  }

  window.addEventListener('beforeunload', () => {
    if (typeof state.unsubscribeAppointments === 'function') {
      try { state.unsubscribeAppointments(); } catch(_) {}
    }
  });

  // start
  guardAuth();
})();
