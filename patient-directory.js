(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof window.firebase === 'undefined') return;

  let db;

  const swiperEl = document.querySelector('.swiper');
  const swiperWrapper = document.querySelector('.swiper .swiper-wrapper');
  const directoryContainer = document.querySelector('.doctor-directory .isotope-container');

  const profileImgEl = document.getElementById('doctor-image');
  const profileNameEl = document.getElementById('doctor-name');
  const profileSpecEl = document.getElementById('doctor-specialty');
  const profileBioEl = document.getElementById('doctor-bio');
  const scheduleGridEl = document.getElementById('doctor-schedule');

  const doctorInput = document.getElementById('doctorInput');
  const doctorIdHidden = document.getElementById('doctorIdHidden');
  const dateInput = document.getElementById('dateInput');
  const timeSelect = document.getElementById('timeSelect');

  let calendarInstance = null;
  let calendarLibTries = 0;
  let currentSelectedDoctorId = null;

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function parseHHMM(hhmm) {
    const [h, m] = (hhmm || '').split(':').map(v => parseInt(v, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  }
  function to12h(minutesFromMidnight) {
    const h24 = Math.floor(minutesFromMidnight / 60);
    const m = minutesFromMidnight % 60;
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0,0,0,0);
    return d;
  }
  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function parseAnyTimeToHHMM(value) {
    if (!value) return undefined;
    if (/^\d{1,2}:\d{2}$/.test(value)) return value;
    const m = value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return undefined;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  function normalizeSlotListToHHMM(listMaybe) {
    if (!Array.isArray(listMaybe)) return undefined;
    const out = [];
    for (const t of listMaybe) {
      const hhmm = parseAnyTimeToHHMM(t);
      if (!hhmm) continue;
      const mins = parseHHMM(hhmm);
      if (mins != null && mins % 60 === 0) out.push(hhmm);
    }
    return out.length ? Array.from(new Set(out)) : undefined;
  }

  function getWorkingDays(doctor) {
    const sched = doctor && doctor.schedule ? doctor.schedule : {};
    if (Array.isArray(sched.workingDays)) return sched.workingDays;
    return [1,2,3,4,5]; // Mon-Fri default
  }

  function buildHourlySlots(date, startHHMM, endHHMM) {
    const startMin = parseHHMM(startHHMM);
    const endMin = parseHHMM(endHHMM);
    if (startMin == null || endMin == null) return [];
    const slots = [];
    for (let t = startMin; t + 60 <= endMin; t += 60) {
      const slotDate = new Date(date);
      slotDate.setHours(Math.floor(t / 60), t % 60, 0, 0);
      slots.push(slotDate);
    }
    return slots;
  }

  function buildSlotsForDate(date, schedule) {
    const start = (schedule && schedule.startHour) || '09:00';
    const end = (schedule && schedule.endHour) || '17:00';
    const slots = (schedule && schedule.slotList) ? schedule.slotList.map(hhmm => {
      const mins = parseHHMM(hhmm);
      const slotDate = new Date(date);
      slotDate.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
      return slotDate;
    }) : buildHourlySlots(date, start, end);
    return slots;
  }

  async function fetchDoctors() {
    const snap = await db.collection('public_doctors').get();
    return snap.docs.map(d => {
      const v = d.data() || {};
      const schedule = {
        workingDays: Array.isArray(v.workingDays) ? v.workingDays : [1,2,3,4,5],
        startHour: v.startHour || (v.schedule && v.schedule.startHour) || '09:00',
        endHour: v.endHour || (v.schedule && v.schedule.endHour) || '17:00',
        slotList: normalizeSlotListToHHMM((v.schedule && v.schedule.slots) || v.slots),
      };
      return {
        id: d.id,
        name: v.name || 'Doctor',
        specialty: v.specialty || '',
        bio: v.bio || '',
        photoUrl: v.photoUrl || 'logo.png',
        schedule,
      };
    });
  }

  function renderDoctorsToSwiper(doctors) {
    if (!swiperWrapper) return;
    swiperWrapper.innerHTML = '';
    doctors.forEach(doc => {
      const slide = document.createElement('div');
      slide.className = 'swiper-slide';
      slide.innerHTML = `
        <div class="minimal-card text-center" data-doctor-id="${doc.id}">
          <img src="${doc.photoUrl}" alt="${doc.name}" class="avatar img-fluid" loading="lazy">
          <div class="info">
            <h4 class="mb-0">${doc.name}</h4>
            <small>${doc.specialty || ''}</small>
          </div>
        </div>`;
      swiperWrapper.appendChild(slide);
    });

    if (swiperEl && !swiperEl.swiper && typeof Swiper !== 'undefined') {
      new Swiper(swiperEl, {
        slidesPerView: 2,
        spaceBetween: 15,
        navigation: { nextEl: '.swiper-button-next', prevEl: '.swiper-button-prev' },
        pagination: { el: '.swiper-pagination', clickable: true },
        breakpoints: { 768: { slidesPerView: 3 }, 992: { slidesPerView: 4 }, 1200: { slidesPerView: 5 } },
      });
    }
  }

  function renderDoctorsToDirectory(doctors) {
    if (!directoryContainer) return;
    directoryContainer.innerHTML = '';
    doctors.forEach(doc => {
      const col = document.createElement('div');
      col.className = 'col-lg-3 col-md-6 doctor-item';
      col.innerHTML = `
        <article class="doctor-card h-100" data-doctor-id="${doc.id}">
          <figure class="doctor-media">
            <img src="${doc.photoUrl}" class="img-fluid" alt="${doc.name}" loading="lazy">
          </figure>
          <div class="doctor-content">
            <h3 class="doctor-name">${doc.name}</h3>
            <p class="doctor-title">${doc.specialty || ''}</p>
            <div class="doctor-actions">
              <a href="#appointment" class="btn btn-sm btn-appointment" data-doctor-id="${doc.id}">Book Appointment</a>
            </div>
          </div>
        </article>`;
      directoryContainer.appendChild(col);
    });
  }

  function updateProfileView(doctor) {
    if (profileImgEl) profileImgEl.src = doctor.photoUrl || 'logo.png';
    if (profileNameEl) profileNameEl.textContent = doctor.name || '';
    if (profileSpecEl) profileSpecEl.textContent = doctor.specialty || '';
    if (profileBioEl) profileBioEl.textContent = doctor.bio || '';
  }

  function destroyCalendarIfAny() {
    if (calendarInstance && typeof calendarInstance.destroy === 'function') {
      calendarInstance.destroy();
      calendarInstance = null;
    }
  }

  async function populateTimesForDate(doctor, date) {
    if (!timeSelect) return;
    timeSelect.innerHTML = '<option value="">Loading...</option>';
    const slots = buildSlotsForDate(date, doctor.schedule);
    const today = new Date();
    const effective = isSameDay(date, today) ? slots.filter(s => s.getTime() > Date.now()) : slots;

    // Fetch booked slots for doctor/date
    let booked = new Set();
    try {
      const start = new Date(date); start.setHours(0,0,0,0);
      const end = new Date(date); end.setHours(23,59,59,999);
      const snap = await db.collection('appointments')
        .where('doctorId', '==', doctor.id)
        .where('startAt', '>=', firebase.firestore.Timestamp.fromDate(start))
        .where('startAt', '<=', firebase.firestore.Timestamp.fromDate(end))
        .get();
      snap.forEach(d => {
        const v = d.data();
        if (v && v.startAt && v.startAt.toDate) {
          booked.add(v.startAt.toDate().getTime());
        }
      });
    } catch (_) {}

    const available = effective.filter(d => !booked.has(d.getTime()));

    timeSelect.innerHTML = '<option value="">Select Time</option>';
    available.forEach(d => {
      const value = to12h(d.getHours() * 60 + d.getMinutes());
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = value;
      timeSelect.appendChild(opt);
    });
    if (available.length === 0) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = 'No times available';
      timeSelect.appendChild(opt);
    } else {
      timeSelect.selectedIndex = 1;
    }
  }

  async function initCalendarForDoctor(doctor) {
    if (!dateInput) return;
    if (typeof flatpickr === 'undefined') {
      if (calendarLibTries++ < 60) setTimeout(() => initCalendarForDoctor(doctor), 100);
      return;
    }
    destroyCalendarIfAny();

    const workingDays = (doctor.schedule && doctor.schedule.workingDays) || [1,2,3,4,5];

    calendarInstance = flatpickr(dateInput, {
      altInput: false,
      dateFormat: 'Y-m-d',
      minDate: 'today',
      inline: true,
      disableMobile: true,
      disable: [
        function (d) {
          return !workingDays.includes(d.getDay());
        },
      ],
      onChange: function (selectedDates) {
        const d = selectedDates && selectedDates[0] ? selectedDates[0] : null;
        if (d) populateTimesForDate(doctor, d);
      },
    });
  }

  async function selectDoctor(doctor) {
    if (currentSelectedDoctorId === doctor.id) return;
    currentSelectedDoctorId = doctor.id;
    if (doctorIdHidden) doctorIdHidden.value = doctor.id;
    if (doctorInput) doctorInput.value = doctor.name || '';

    updateProfileView(doctor);
    initCalendarForDoctor(doctor);
  }

  function attachSelectionHandlers(doctorsById) {
    document.addEventListener('click', async (e) => {
      const minCard = e.target.closest('.minimal-card');
      if (minCard) {
        const id = minCard.getAttribute('data-doctor-id');
        if (!id) return;
        const doc = doctorsById.get(id);
        if (!doc) return;
        document.querySelectorAll('.minimal-card.active').forEach(el => el.classList.remove('active'));
        minCard.classList.add('active');
        await selectDoctor(doc);
        return;
      }
      const bookBtn = e.target.closest('.btn-appointment');
      if (bookBtn) {
        e.preventDefault();
        const id = bookBtn.getAttribute('data-doctor-id') || (bookBtn.closest('[data-doctor-id]') && bookBtn.closest('[data-doctor-id]').getAttribute('data-doctor-id'));
        if (!id) return;
        const doc = doctorsById.get(id);
        if (!doc) return;
        await selectDoctor(doc);
        const section = document.getElementById('appointment');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  async function bootstrap() {
    try {
      if (!(firebase && firebase.apps && firebase.apps.length)) return;
      db = firebase.firestore();

      const doctorsSnap = await db.collection('public_doctors').get();
      const doctors = doctorsSnap.docs.map(d => {
        const v = d.data() || {};
        return {
          id: d.id,
          name: v.name || 'Doctor',
          specialty: v.specialty || '',
          bio: v.bio || '',
          photoUrl: v.photoUrl || 'logo.png',
          schedule: {
            workingDays: Array.isArray(v.workingDays) ? v.workingDays : [1,2,3,4,5],
            startHour: v.startHour || '09:00',
            endHour: v.endHour || '17:00',
          },
        };
      });

      if (swiperWrapper) renderDoctorsToSwiper(doctors);
      if (directoryContainer) renderDoctorsToDirectory(doctors);

      const doctorsById = new Map(doctors.map(d => [d.id, d]));
      attachSelectionHandlers(doctorsById);

      // Preselect via URL param if present
      const urlDoctorId = new URL(window.location.href).searchParams.get('doctorId');
      if (urlDoctorId && doctorsById.has(urlDoctorId)) {
        await selectDoctor(doctorsById.get(urlDoctorId));
      }
    } catch (err) {
      console.error('[patient-directory] init failed', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
