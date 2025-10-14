(function () {
  'use strict';

  if (window.__techmedPatientDirectoryLoaded) return;
  window.__techmedPatientDirectoryLoaded = true;

  let db;

  async function waitUntil(checkFn, { timeoutMs = 10000, intervalMs = 50 } = {}) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      (function poll() {
        try {
          if (checkFn()) return resolve(true);
        } catch (_) {}
        if (Date.now() - start >= timeoutMs) return reject(new Error('timeout'));
        setTimeout(poll, intervalMs);
      })();
    });
  }

  const swiperEl = document.querySelector('.swiper');
  const swiperWrapper = document.querySelector('.swiper .swiper-wrapper');
  const directoryContainer = document.querySelector('.doctor-directory .isotope-container');

  const profileImgEl = document.getElementById('doctor-image');
  const profileNameEl = document.getElementById('doctor-name');
  const profileSpecEl = document.getElementById('doctor-specialty');
  const profileBioEl = document.getElementById('doctor-bio');
  const scheduleGridEl = document.getElementById('doctor-schedule');

  const form = document.getElementById('appointment-form');
  const doctorInput = document.getElementById('doctorInput');
  const doctorIdHidden = document.getElementById('doctorIdHidden');
  const dateInput = document.getElementById('dateInput');
  const timeSelect = document.getElementById('timeSelect');

  let calendarInstance = null;
  let calendarLibTries = 0;
  let currentSelectedDoctorId = null;

  const urlDoctorId = new URL(window.location.href).searchParams.get('doctorId');

  const monthlyBookingsCache = new Map();
  const monthlyDailyAvailabilityCache = new Map();

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_NAME_TO_INDEX = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };

  function slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  function formatYMD(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function monthKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function to12h(timeMinutes) {
    const hours24 = Math.floor(timeMinutes / 60);
    const minutes = timeMinutes % 60;
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    const hours12 = hours24 % 12 || 12;
    return `${String(hours12)}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  }

  function parseHHMM(hhmm) {
    const [h, m] = (hhmm || '').split(':').map(v => parseInt(v, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  }

  function parse12hToHHMM(s) {
    if (!s) return null;
    const m = s.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  function parse12hRangeToHHMM(rangeStr) {
    if (!rangeStr || typeof rangeStr !== 'string') return null;
    const parts = rangeStr.split('-');
    if (parts.length !== 2) return null;
    const start = parse12hToHHMM(parts[0].trim());
    const end = parse12hToHHMM(parts[1].trim());
    if (!start || !end) return null;
    return { startHour: start, endHour: end };
  }

  function parse24hRangeToHHMM(rangeStr) {
    if (!rangeStr || typeof rangeStr !== 'string') return null;
    const parts = rangeStr.split('-');
    if (parts.length !== 2) return null;
    const start = (parts[0] || '').trim();
    const end = (parts[1] || '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) return null;
    return { startHour: start, endHour: end };
  }

  function parseAnyRangeToHHMM(rangeStr) {
    return parse12hRangeToHHMM(rangeStr) || parse24hRangeToHHMM(rangeStr);
  }

  function parseAnyTimeToHHMM(value) {
    if (!value) return undefined;
    if (/^\d{1,2}:\d{2}$/.test(value)) return value;
    return parse12hToHHMM(value) || undefined;
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

  function looksLikeDayMap(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const keys = Object.keys(obj);
    let dayLikeCount = 0;
    for (const k of keys) {
      const kl = String(k).toLowerCase();
      if (/^\d+$/.test(kl)) { dayLikeCount += 1; continue; }
      if (kl in DAY_NAME_TO_INDEX) { dayLikeCount += 1; continue; }
    }
    return dayLikeCount > 0;
  }

  function normalizeWorkingDays(daysMaybe) {
    if (!Array.isArray(daysMaybe)) return undefined;
    const result = [];
    for (const d of daysMaybe) {
      if (typeof d === 'number' && d >= 0 && d <= 6) {
        result.push(d);
      } else if (typeof d === 'string') {
        const idx = DAY_NAME_TO_INDEX[d.trim().toLowerCase()];
        if (typeof idx === 'number') result.push(idx);
      }
    }
    return result.length ? Array.from(new Set(result)).sort() : undefined;
  }

  function coerceHHMM(val) {
    if (!val) return undefined;
    if (/^\d{1,2}:\d{2}$/.test(val)) return val;
    const c = parse12hToHHMM(val);
    return c || undefined;
  }

  function extractScheduleFromData(raw) {
    const top = raw || {};
    const schedTop = top.schedule || {};
    const schedule = {
      workingDays: normalizeWorkingDays(top.workingDays) || normalizeWorkingDays(schedTop.workingDays),
      startHour: coerceHHMM(top.startHour || schedTop.startHour),
      endHour: coerceHHMM(top.endHour || schedTop.endHour),
      slotMinutes: parseInt(top.slotMinutes || schedTop.slotMinutes, 10) || undefined,
      byDay: undefined,
    };

    let weekly = top.weeklySchedule || schedTop.weeklySchedule || top.availability || schedTop.availability || top.scheduleByDay || schedTop.scheduleByDay || top.hoursByDay || schedTop.hoursByDay || top.byDay || schedTop.byDay || top.days || schedTop.days || top.slotsByDay || schedTop.slotsByDay || top.timesByDay || schedTop.timesByDay;
    if (!weekly && looksLikeDayMap(schedTop)) weekly = schedTop;

    const byDay = {};
    const wdSet = new Set(Array.isArray(schedule.workingDays) ? schedule.workingDays : []);

    if (Array.isArray(weekly)) {
      weekly.forEach(item => {
        if (!item) return;
        const dayRaw = String(item.day || item.Day || item.weekday || '').toLowerCase();
        const idx = typeof item.dayIndex === 'number' ? item.dayIndex : DAY_NAME_TO_INDEX[dayRaw];
        const isOff = item.off === true || item.closed === true || item.available === false;
        const range = item.range || item.time || item.hours;
        let start = coerceHHMM(item.start || item.startHour);
        let end = coerceHHMM(item.end || item.endHour);
        if ((!start || !end) && range) {
          const r = parseAnyRangeToHHMM(range);
          start = start || r?.startHour;
          end = end || r?.endHour;
        }
        const slots = normalizeSlotListToHHMM(item.slots || item.times || item.timeSlots);
        if (typeof idx === 'number') {
          if (!isOff && (slots || (start && end))) {
            byDay[idx] = { startHour: start, endHour: end, slots };
            wdSet.add(idx);
          }
        }
      });
    } else if (weekly && typeof weekly === 'object') {
      Object.entries(weekly).forEach(([key, val]) => {
        const keyLower = key.toLowerCase();
        const idx = /^\d+$/.test(keyLower) ? parseInt(keyLower, 10) : DAY_NAME_TO_INDEX[keyLower];
        if (typeof idx !== 'number') return;
        let start, end, slots, isOff;
        if (typeof val === 'string') {
          const r = parseAnyRangeToHHMM(val);
          start = r?.startHour; end = r?.endHour;
        } else if (val && typeof val === 'object') {
          start = coerceHHMM(val.start || val.startHour);
          end = coerceHHMM(val.end || val.endHour);
          slots = normalizeSlotListToHHMM(val.slots || val.times || val.timeSlots);
          isOff = val.off === true || val.closed === true || val.available === false;
          if ((!start || !end) && (val.time || val.range || val.hours)) {
            const r = parseAnyRangeToHHMM(val.time || val.range || val.hours);
            start = start || r?.startHour;
            end = end || r?.endHour;
          }
        }
        if (!isOff && (slots || (start && end))) {
          byDay[idx] = { startHour: start, endHour: end, slots };
          wdSet.add(idx);
        }
      });
    }

    if (Object.keys(byDay).length) {
      schedule.byDay = byDay;
      schedule.workingDays = Array.from(wdSet).sort();
    }

    if (!schedule.slotMinutes) schedule.slotMinutes = 30;

    return schedule;
  }

  function startOfDay(date) { const d = new Date(date); d.setHours(0,0,0,0); return d; }
  function filterPastSlots(slots) { const now = new Date(); return slots.filter(d => d.getTime() > now.getTime()); }

  function getWorkingDays(doctor) {
    const sched = doctor?.schedule || {};
    if (Array.isArray(sched.workingDays) && sched.workingDays.length) return sched.workingDays;
    if (sched.byDay && typeof sched.byDay === 'object') {
      const keys = Object.keys(sched.byDay)
        .map(k => (Number.isInteger(+k) ? +k : DAY_NAME_TO_INDEX[String(k).toLowerCase()]))
        .filter(v => typeof v === 'number' && v >= 0 && v <= 6);
      const unique = Array.from(new Set(keys)).sort();
      if (unique.length) return unique;
    }
    return [];
  }

  function effectiveScheduleForDay(schedule, dayIndex) {
    const sched = schedule || {};
    const byDay = sched.byDay || {};
    const dayOverride = byDay[dayIndex];
    return {
      startHour: (dayOverride && dayOverride.startHour) || sched.startHour,
      endHour: (dayOverride && dayOverride.endHour) || sched.endHour,
      slotMinutes: parseInt(sched.slotMinutes, 10) || 30,
      slotList: dayOverride && Array.isArray(dayOverride.slots) ? dayOverride.slots : undefined,
    };
  }

  function buildHourlySlots(date, startHHMM, endHHMM) {
    const parseHH = (hhmm) => { const [h, m] = (hhmm || '').split(':').map(v => parseInt(v, 10)); return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m; };
    const startMin = parseHH(startHHMM);
    const endMin = parseHH(endHHMM);
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
    const eff = effectiveScheduleForDay(schedule, date.getDay());
    const slots = [];
    if (eff.slotList && eff.slotList.length) {
      for (const hhmm of eff.slotList) {
        const mins = parseHHMM(hhmm);
        if (mins == null) continue;
        const slotDate = new Date(date);
        const hours = Math.floor(mins / 60);
        const minutes = mins % 60;
        slotDate.setHours(hours, minutes, 0, 0);
        slots.push(slotDate);
      }
      return slots.sort((a,b) => a - b);
    }
    if (!eff.startHour || !eff.endHour) return slots;
    return buildHourlySlots(date, eff.startHour, eff.endHour);
  }

  async function buildSlotsForDateWithDaily(doctor, date) {
    const daily = await getDailyOverride(doctor.id, date);
    const slots = [];
    if (daily) {
      if (daily.off) return slots;
      if (daily.slots && daily.slots.length) {
        for (const hhmm of daily.slots) {
          const mins = parseHHMM(hhmm);
          if (mins == null) continue;
          const slotDate = new Date(date);
          slotDate.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
          slots.push(slotDate);
        }
        return slots.sort((a,b) => a - b);
      }
      if (daily.startHour && daily.endHour) {
        return buildHourlySlots(date, daily.startHour, daily.endHour);
      }
      return slots;
    }
    return buildSlotsForDate(date, doctor.schedule || {});
  }

  async function prefetchMonthBookings(doctorId, year, monthIndex) {
    const first = new Date(year, monthIndex, 1, 0, 0, 0, 0);
    const last = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
    const mKey = `${doctorId}|${monthKey(first)}`;
    if (monthlyBookingsCache.has(mKey)) return monthlyBookingsCache.get(mKey);
    const snap = await db.collection('appointments')
      .where('startAt', '>=', firebase.firestore.Timestamp.fromDate(first))
      .where('startAt', '<=', firebase.firestore.Timestamp.fromDate(last))
      .get();
    const dayToSet = new Map();
    snap.forEach(d => {
      const v = d.data();
      if (!v || v.doctorId !== doctorId) return;
      const ts = v && v.startAt && v.startAt.toDate ? v.startAt.toDate() : null;
      if (!ts) return;
      const dayKey = formatYMD(ts);
      let set = dayToSet.get(dayKey);
      if (!set) { set = new Set(); dayToSet.set(dayKey, set); }
      set.add(ts.getTime());
    });
    monthlyBookingsCache.set(mKey, dayToSet);
    return dayToSet;
  }

  function normalizeDailyDoc(v) {
    if (!v || typeof v !== 'object') return null;
    const off = v.off === true || v.closed === true || v.available === false;
    const slots = normalizeSlotListToHHMM(v.slots || v.times || v.timeSlots);
    let startHour = (v.start || v.startHour);
    let endHour = (v.end || v.endHour);
    if ((!startHour || !endHour) && (v.time || v.range || v.hours)) {
      const r = parseAnyRangeToHHMM(v.time || v.range || v.hours);
      startHour = startHour || r?.startHour;
      endHour = endHour || r?.endHour;
    }
    if (off) return { off: true };
    if (!slots && (!startHour || !endHour)) return null;
    return { slots, startHour, endHour };
  }

  async function prefetchMonthDailyAvailability(doctorId, year, monthIndex) {
    const first = new Date(year, monthIndex, 1, 0, 0, 0, 0);
    const last = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
    const mKey = `${doctorId}|${monthKey(first)}`;
    if (monthlyDailyAvailabilityCache.has(mKey)) return monthlyDailyAvailabilityCache.get(mKey);

    const map = new Map();
    try {
      const coll = db.collection('public_doctors').doc(doctorId).collection('availability');
      try {
        const snap = await coll
          .where('date', '>=', firebase.firestore.Timestamp.fromDate(first))
          .where('date', '<=', firebase.firestore.Timestamp.fromDate(last))
          .get();
        snap.forEach(doc => {
          const v = doc.data() || {};
          let d = v.date && v.date.toDate ? v.date.toDate() : null;
          let key = v.dateStr || null;
          if (d) key = formatYMD(d);
          if (!key) {
            const idYmd = doc.id;
            if (/^\d{4}-\d{2}-\d{2}$/.test(idYmd)) key = idYmd;
          }
          if (!key) return;
          const dayConf = normalizeDailyDoc(v);
          if (dayConf) map.set(key, dayConf);
        });
      } catch (_) {
        const snap = await coll.get();
        snap.forEach(doc => {
          const v = doc.data() || {};
          let key = v.dateStr || null;
          if (!key) {
            const d = v.date && v.date.toDate ? v.date.toDate() : null;
            if (d) key = formatYMD(d);
          }
          if (!key) {
            const idYmd = doc.id;
            if (/^\d{4}-\d{2}-\d{2}$/.test(idYmd)) key = idYmd;
          }
          if (!key) return;
          const dObj = new Date(`${key}T00:00:00`);
          if (dObj < first || dObj > last) return;
          const dayConf = normalizeDailyDoc(v);
          if (dayConf) map.set(key, dayConf);
        });
      }
    } catch {}

    monthlyDailyAvailabilityCache.set(mKey, map);
    return map;
  }

  async function getDailyOverride(doctorId, date) {
    const mk = `${doctorId}|${monthKey(date)}`;
    if (!monthlyDailyAvailabilityCache.has(mk)) {
      await prefetchMonthDailyAvailability(doctorId, date.getFullYear(), date.getMonth());
    }
    const map = monthlyDailyAvailabilityCache.get(mk) || new Map();
    return map.get(formatYMD(date)) || null;
  }

  async function getBookedSetForDayFromCacheOrFetch(doctorId, date) {
    const mk = `${doctorId}|${monthKey(date)}`;
    if (!monthlyBookingsCache.has(mk)) {
      await prefetchMonthBookings(doctorId, date.getFullYear(), date.getMonth());
    }
    const map = monthlyBookingsCache.get(mk) || new Map();
    const set = map.get(formatYMD(date));
    return set ? new Set(set) : new Set();
  }

  async function fetchDoctors() {
    let snap;
    try {
      snap = await db.collection('public_doctors').orderBy('name', 'asc').get();
    } catch (e) {
      snap = await db.collection('public_doctors').get();
    }
    return snap.docs.map(d => {
      const v = d.data() || {};
      const schedule = extractScheduleFromData(v);
      return {
        id: d.id,
        name: v.name || v.fullName || 'Doctor',
        specialty: v.specialty || v.department || v.title || '',
        bio: v.bio || v.about || '',
        photoUrl: v.photoUrl || v.photo || v.image || v.avatarUrl || '',
        reviews: v.reviews || v.review || '',
        schedule,
      };
    });
  }

  let swiperInitTries = 0;
  function ensureSwiperInitialized() {
    if (!swiperEl) return;
    if (swiperEl && swiperEl.swiper) return;
    if (typeof Swiper === 'undefined') {
      if (swiperInitTries++ < 60) setTimeout(ensureSwiperInitialized, 100);
      return;
    }
    // eslint-disable-next-line no-new
    new Swiper(swiperEl, {
      slidesPerView: 2,
      spaceBetween: 15,
      navigation: { nextEl: '.swiper-button-next', prevEl: '.swiper-button-prev' },
      pagination: { el: '.swiper-pagination', clickable: true },
      breakpoints: { 768: { slidesPerView: 3 }, 992: { slidesPerView: 4 }, 1200: { slidesPerView: 5 } },
    });
  }

  function renderDoctorsToSwiper(doctors) {
    if (!swiperWrapper) return;
    swiperWrapper.innerHTML = '';
    doctors.forEach(doc => {
      const slide = document.createElement('div');
      slide.className = 'swiper-slide';
      slide.innerHTML = `
        <div class="minimal-card text-center" data-doctor-id="${doc.id}"
             data-name="${doc.name}"
             data-specialty="${doc.specialty || ''}"
             data-image="${doc.photoUrl || 'logo.png'}"
             data-bio="${doc.bio || ''}"
             data-reviews="${doc.reviews || ''}">
          <img src="${doc.photoUrl || 'logo.png'}" alt="${doc.name}" class="avatar img-fluid" loading="lazy">
          <div class="info">
            <h4 class="mb-0">${doc.name}</h4>
            <small>${doc.specialty || ''}</small>
          </div>
        </div>`;
      swiperWrapper.appendChild(slide);
    });
    ensureSwiperInitialized();
  }

  function renderDoctorsToDirectory(doctors) {
    if (!directoryContainer) return;
    directoryContainer.innerHTML = '';
    doctors.forEach(doc => {
      const col = document.createElement('div');
      const deptSlug = slugify(doc.specialty || 'general');
      col.className = 'col-lg-3 col-md-6 doctor-item isotope-item ' + `filter-${deptSlug}`;
      col.innerHTML = `
        <article class="doctor-card h-100" data-doctor-id="${doc.id}">
          <figure class="doctor-media">
            <img src="${doc.photoUrl || 'logo.png'}" class="img-fluid" alt="${doc.name}" loading="lazy" onerror="this.onerror=null;this.src='logo.png';">
          </figure>
          <div class="doctor-content">
            <h3 class="doctor-name">${doc.name}</h3>
            <p class="doctor-title">${doc.specialty || ''}</p>
            <p class="doctor-desc">${(doc.bio || '').slice(0, 120)}${(doc.bio || '').length > 120 ? '…' : ''}</p>
            <div class="doctor-meta">
              <span class="badge dept">${doc.specialty || 'Department'}</span>
            </div>
            <div class="doctor-actions">
              <a href="#appointment" class="btn btn-sm btn-appointment" data-doctor-id="${doc.id}" data-doctor="${doc.name}">Book Appointment</a>
              <a href="#" class="btn btn-sm btn-soft view-profile" data-doctor-id="${doc.id}">View Profile</a>
            </div>
          </div>
        </article>`;
      directoryContainer.appendChild(col);
    });
  }

  function updateProfileView(doctor) {
    if (profileImgEl && doctor.photoUrl) profileImgEl.src = doctor.photoUrl;
    if (profileNameEl) profileNameEl.textContent = doctor.name || 'Selected Doctor';
    if (profileSpecEl) profileSpecEl.textContent = doctor.specialty || '';
    if (profileBioEl) profileBioEl.textContent = doctor.bio || '';
    const reviewsEl = document.getElementById('doctor-reviews');
    if (reviewsEl) reviewsEl.textContent = doctor.reviews || 'Reviews will appear here.';

    if (scheduleGridEl) {
      scheduleGridEl.innerHTML = '<div class="text-muted">Select a date to see available times.</div>';
    }
  }

  function destroyCalendarIfAny() {
    if (calendarInstance && typeof calendarInstance.destroy === 'function') {
      calendarInstance.destroy();
      calendarInstance = null;
    }
  }

  async function initCalendarForDoctor(doctor) {
    if (!dateInput) return;
    if (typeof flatpickr === 'undefined') {
      if (calendarLibTries++ < 60) setTimeout(() => initCalendarForDoctor(doctor), 100);
      return;
    }

    destroyCalendarIfAny();

    try {
      const now = new Date();
      await Promise.all([
        prefetchMonthBookings(doctor.id, now.getFullYear(), now.getMonth()),
        prefetchMonthDailyAvailability(doctor.id, now.getFullYear(), now.getMonth()),
      ]);
    } catch {}

    function hasOpenSlotsFromCache(doctorLocal, date) {
      const ymd = formatYMD(date);
      const mk = `${doctorLocal.id}|${monthKey(date)}`;
      const bookedSet = (monthlyBookingsCache.get(mk)?.get(ymd)) || new Set();

      const dailyMap = monthlyDailyAvailabilityCache.get(mk);
      const daily = dailyMap ? dailyMap.get(ymd) : null;
      let candidate = [];
      if (daily) {
        if (daily.off) return false;
        if (daily.slots && daily.slots.length) {
          candidate = daily.slots.map(hhmm => {
            const slot = new Date(date);
            const m = parseHHMM(hhmm);
            slot.setHours(Math.floor(m / 60), m % 60, 0, 0);
            return slot;
          });
        } else if (daily.startHour && daily.endHour) {
          candidate = buildHourlySlots(date, daily.startHour, daily.endHour);
        } else {
          return false;
        }
      } else {
        const wd = getWorkingDays(doctorLocal);
        if (!wd.includes(date.getDay())) return false;
        const by = doctorLocal.schedule && doctorLocal.schedule.byDay ? doctorLocal.schedule.byDay[date.getDay()] : null;
        const startHH = (by && by.startHour) || (doctorLocal.schedule && doctorLocal.schedule.startHour);
        const endHH = (by && by.endHour) || (doctorLocal.schedule && doctorLocal.schedule.endHour);
        if (!startHH || !endHH) return false;
        candidate = buildHourlySlots(date, startHH, endHH);
      }

      if (isSameDay(date, new Date())) {
        candidate = filterPastSlots(candidate);
      }
      for (const s of candidate) {
        if (!bookedSet.has(s.getTime())) return true;
      }
      return false;
    }

    calendarInstance = flatpickr(dateInput, {
      altInput: false,
      dateFormat: 'Y-m-d',
      minDate: 'today',
      inline: true,
      disableMobile: true,
      disable: [
        // Do NOT fully disable days, so we can display color coding even for fully booked/non-working
        // Returning false keeps all days clickable; selection will still be constrained by no options
        function () { return false; },
      ],
      onDayCreate: async function (dObj, dStr, fp, dayElem) {
        try {
          const d = dayElem.dateObj || (dStr ? new Date(`${dStr}T00:00:00`) : null);
          if (!d || isNaN(d.getTime())) return;
          dayElem.classList.remove('available', 'booked', 'semi-disabled', 'not-available');

          const mk = `${doctor.id}|${monthKey(d)}`;
          const map = monthlyBookingsCache.get(mk);
          const bookedSet = map ? (map.get(formatYMD(d)) || new Set()) : new Set();

          const allSlots = await buildSlotsForDateWithDaily(doctor, d);
          const today = new Date();
          const todayStart = new Date(); todayStart.setHours(0,0,0,0);
          const dateStart = new Date(d); dateStart.setHours(0,0,0,0);

          if (allSlots.length === 0) {
            dayElem.classList.add('non-working');
            return;
          }
          if (dateStart < todayStart) {
            dayElem.classList.add('non-working');
            return;
          }

          const effectiveSlots = isSameDay(d, today) ? filterPastSlots(allSlots) : allSlots;
          if (effectiveSlots.length === 0) {
            dayElem.classList.add('non-working');
            return;
          }
          const open = effectiveSlots.filter(s => !bookedSet.has(s.getTime()));
          if (open.length <= 0) {
            dayElem.classList.add('booked');
          } else {
            dayElem.classList.add('available');
          }
        } catch (_) { /* ignore */ }
      },
      onReady: async function (selectedDates, dateStr, fp) {
        const currentFirst = new Date(fp.currentYear, fp.currentMonth, 1);
        await Promise.all([
          prefetchMonthBookings(doctor.id, currentFirst.getFullYear(), currentFirst.getMonth()),
          prefetchMonthDailyAvailability(doctor.id, currentFirst.getFullYear(), currentFirst.getMonth()),
        ]);
        fp.redraw();
      },
      onMonthChange: async function (selectedDates, dateStr, fp) {
        const currentFirst = new Date(fp.currentYear, fp.currentMonth, 1);
        await Promise.all([
          prefetchMonthBookings(doctor.id, currentFirst.getFullYear(), currentFirst.getMonth()),
          prefetchMonthDailyAvailability(doctor.id, currentFirst.getFullYear(), currentFirst.getMonth()),
        ]);
        fp.redraw();
      },
      onYearChange: async function (selectedDates, dateStr, fp) {
        const currentFirst = new Date(fp.currentYear, fp.currentMonth, 1);
        await Promise.all([
          prefetchMonthBookings(doctor.id, currentFirst.getFullYear(), currentFirst.getMonth()),
          prefetchMonthDailyAvailability(doctor.id, currentFirst.getFullYear(), currentFirst.getMonth()),
        ]);
        fp.redraw();
      },
      onChange: function (selectedDates) {
        const d = selectedDates && selectedDates[0] ? selectedDates[0] : null;
        if (d) { populateTimesForDate(doctor, d); }
      },
    });
  }

  async function fetchBookedForDay(doctorId, date) {
    try {
      if (!monthlyBookingsCache.has(`${doctorId}|${monthKey(date)}`)) {
        const start = new Date(date); start.setHours(0,0,0,0);
        const end = new Date(date); end.setHours(23,59,59,999);
        const snap = await db.collection('appointments')
          .where('startAt', '>=', firebase.firestore.Timestamp.fromDate(start))
          .where('startAt', '<=', firebase.firestore.Timestamp.fromDate(end))
          .get();
        const set = new Set();
        snap.forEach(doc => {
          const v = doc.data();
          if (!v || v.doctorId !== doctorId) return;
          if (v.startAt && v.startAt.toDate) set.add(v.startAt.toDate().getTime());
        });
        return set;
      }
      return await getBookedSetForDayFromCacheOrFetch(doctorId, date);
    } catch (e) {
      return new Set();
    }
  }

  async function populateTimesForDate(doctor, date) {
    if (!timeSelect) return;

    function to12(valueMinutes) {
      const h24 = Math.floor(valueMinutes / 60);
      const m = valueMinutes % 60;
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12 = h24 % 12 || 12;
      return `${String(h12)}:${m.toString().padStart(2, '0')} ${ampm}`;
    }

    timeSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      // Build slots considering daily overrides (off, special slots, or custom hours)
      let baseSlots = await buildSlotsForDateWithDaily(doctor, date);
      if (!baseSlots || !baseSlots.length) {
        const eff = effectiveScheduleForDay(doctor.schedule || {}, date.getDay());
        if (eff.slotList && eff.slotList.length) {
          baseSlots = eff.slotList.map(hhmm => {
            const mins = parseHHMM(hhmm);
            const d = new Date(date);
            d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
            return d;
          });
        } else if (eff.startHour && eff.endHour) {
          baseSlots = buildHourlySlots(date, eff.startHour, eff.endHour);
        } else {
          baseSlots = [];
        }
      }

      const today = new Date();
      const slots = startOfDay(date).toDateString() === today.toDateString() ? filterPastSlots(baseSlots) : baseSlots;

      const booked = await fetchBookedForDay(doctor.id, date);
      const available = slots.filter(d => !booked.has(d.getTime()));

      // Render options with color coding via classes
      timeSelect.innerHTML = '<option value="">Select Time</option>';
      // Build a map for quick lookup
      const availableMs = new Set(available.map(d => d.getTime()));
      const seen = new Set();
      [...slots].sort((a,b) => a - b).forEach(d => {
        const hours = d.getHours();
        const minutes = d.getMinutes();
        const valueMinutes = hours * 60 + minutes;
        const label = to12(valueMinutes);
        if (seen.has(label)) return; // dedupe if any
        seen.add(label);
        const opt = document.createElement('option');
        opt.value = label;
        opt.textContent = label;
        const isOpen = availableMs.has(d.getTime());
        opt.disabled = !isOpen;
        opt.className = isOpen ? 'slot-available' : 'slot-booked';
        timeSelect.appendChild(opt);
      });

      if (available.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No times available';
        timeSelect.appendChild(opt);
      } else {
        // Select first enabled option
        const firstEnabled = [...timeSelect.options].find(o => o.value && !o.disabled);
        if (firstEnabled) firstEnabled.selected = true;
      }
    } catch (e) {
      timeSelect.innerHTML = '<option value="">No times available</option>';
    }
  }

  async function selectDoctor(doctor) {
    if (currentSelectedDoctorId === doctor.id) return;
    if (doctorInput) doctorInput.value = doctor.name;
    if (doctorIdHidden) doctorIdHidden.value = doctor.id;
    currentSelectedDoctorId = doctor.id;

    updateProfileView(doctor);
    renderWeeklySchedule(doctor);
    initCalendarForDoctor(doctor);

    if (calendarInstance && calendarInstance.selectedDates?.length) {
      await populateTimesForDate(doctor, calendarInstance.selectedDates[0]);
    } else if (dateInput && dateInput.value) {
      const d = new Date(dateInput.value);
      if (!isNaN(d.getTime())) await populateTimesForDate(doctor, d);
    }
  }

  function renderWeeklySchedule(doctor) {
    if (!scheduleGridEl) return;
    const sched = doctor.schedule || {};
    const byDay = sched.byDay || {};
    const working = getWorkingDays(doctor);
    if ((!working || working.length === 0) && (!byDay || Object.keys(byDay).length === 0)) {
      scheduleGridEl.innerHTML = '<div class="text-muted">No schedule available.</div>';
      return;
    }

    const daysToRender = byDay && Object.keys(byDay).length
      ? Array.from(new Set(Object.keys(byDay)
          .map(k => (Number.isInteger(+k) ? +k : DAY_NAME_TO_INDEX[String(k).toLowerCase()]))
          .filter(v => typeof v === 'number'))).sort((a,b) => a-b)
      : working;

    let html = '<div class="row g-2">';
    daysToRender.forEach(i => {
      const dConf = byDay[i] || null;
      let range = '';
      if (dConf && (dConf.startHour || dConf.endHour)) {
        const sMin = parseHHMM(dConf.startHour);
        const eMin = parseHHMM(dConf.endHour);
        range = `${sMin != null ? to12h(sMin) : ''}${sMin != null && eMin != null ? ' - ' : ''}${eMin != null ? to12h(eMin) : ''}`;
      } else if (sched.startHour && sched.endHour) {
        const sMin = parseHHMM(sched.startHour);
        const eMin = parseHHMM(sched.endHour);
        range = `${to12h(sMin)} - ${to12h(eMin)}`;
      }
      html += `
        <div class="col-6 col-md-4">
          <div class="border rounded p-2 h-100 ${range ? 'bg-available-day' : 'bg-unavailable-day'}">
            <div class="fw-semibold">${DAY_NAMES[i]}</div>
            <div class="small">${range || '—'}</div>
          </div>
        </div>`;
    });
    html += '</div>';
    scheduleGridEl.innerHTML = html;
  }

  function attachSelectionHandlers(doctorsById) {
    const root = document;
    root.addEventListener('click', async (e) => {
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

      // Only intercept directory anchor buttons, not the submit button in the form
      const bookBtn = e.target.closest('a.btn-appointment');
      if (bookBtn) {
        e.preventDefault();
        const holder = bookBtn.closest('[data-doctor-id]');
        const id = (bookBtn.getAttribute('data-doctor-id')) || (holder && holder.getAttribute('data-doctor-id'));
        if (!id) return;
        const doc = doctorsById.get(id);
        if (!doc) return;
        await selectDoctor(doc);
        const section = document.getElementById('appointment');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      const viewBtn = e.target.closest('.view-profile');
      if (viewBtn) {
        e.preventDefault();
        const holder = viewBtn.closest('[data-doctor-id]');
        const id = (viewBtn.getAttribute('data-doctor-id')) || (holder && holder.getAttribute('data-doctor-id'));
        if (!id) return;
        const doc = doctorsById.get(id);
        if (!doc) return;
        await selectDoctor(doc);
      }
    });
  }

  async function bootstrap() {
    try {
      // Inject minimal styles for calendar/time color coding if not already present
      (function ensureBookingStyles() {
        if (document.getElementById('bookingColorStyles')) return;
        const style = document.createElement('style');
        style.id = 'bookingColorStyles';
        style.textContent = `
          .flatpickr-day.available{ background:#e6ffed; color:#093; border-radius:50%; }
          .flatpickr-day.booked{ background:#ffe0e0; color:#a40000; border-radius:50%; }
          .flatpickr-day.non-working{ background:#f1f3f5; color:#6c757d; border-radius:50%; }
          .flatpickr-day.selected{ background:#87cefa!important; color:#000!important; border-radius:50%; }
          select#timeSelect option.slot-available { color:#198754; font-weight:500; }
          select#timeSelect option.slot-booked { color:#dc3545; }
        `;
        document.head.appendChild(style);
      })();

      await waitUntil(() => window.firebase && firebase.apps && firebase.apps.length > 0);
      db = firebase.firestore();

      const doctors = await fetchDoctors();

      if (doctors.length === 0) {
        if (swiperWrapper) swiperWrapper.innerHTML = '<div class="p-4">No doctors found.</div>';
        if (directoryContainer) directoryContainer.innerHTML = '<div class="p-4">No doctors found.</div>';
        return;
      }

      renderDoctorsToSwiper(doctors);
      renderDoctorsToDirectory(doctors);

      window.addEventListener('load', ensureSwiperInitialized, { once: true });

      const doctorsById = new Map(doctors.map(d => [d.id, d]));
      attachSelectionHandlers(doctorsById);

      if (urlDoctorId && doctorsById.has(urlDoctorId)) {
        await selectDoctor(doctorsById.get(urlDoctorId));
      } else if (doctorIdHidden && doctorIdHidden.value && doctorsById.has(doctorIdHidden.value)) {
        await selectDoctor(doctorsById.get(doctorIdHidden.value));
      } else if (doctorInput && doctorInput.value) {
        const match = doctors.find(d => d.name === doctorInput.value);
        if (match) await selectDoctor(match);
      }

      if (dateInput) {
        dateInput.addEventListener('change', async () => {
          const id = doctorIdHidden && doctorIdHidden.value;
          if (!id || !dateInput.value) return;
          const docSnap = await db.collection('public_doctors').doc(id).get();
          if (!docSnap.exists) return;
          const dData = docSnap.data() || {};
          const selectedDoc = {
            id: docSnap.id,
            name: dData.name || dData.fullName || 'Doctor',
            specialty: dData.specialty || dData.department || dData.title || '',
            bio: dData.bio || dData.about || '',
            photoUrl: dData.photoUrl || dData.photo || dData.image || dData.avatarUrl || '',
            reviews: dData.reviews || dData.review || '',
            schedule: extractScheduleFromData(dData),
          };
          const d = new Date(dateInput.value);
          if (!isNaN(d.getTime())) await populateTimesForDate(selectedDoc, d);
        });
      }

      // Wire topbar "Appointments" button to show patient's booked appointments
      (function wireAppointmentsTopbar() {
        const apptBtn = document.getElementById('appointmentBtn');
        const modalEl = document.getElementById('appointmentModal');
        const tableBody = document.querySelector('#appointmentTable tbody');
        if (!apptBtn || !modalEl || !tableBody) return;
        // Change table header to Doctor for patient POV if present
        const thFirst = document.querySelector('#appointmentTable thead th:first-child');
        if (thFirst) thFirst.textContent = 'Doctor';

        async function fetchPatientAppointments() {
          const user = (firebase.auth && firebase.auth().currentUser) || null;
          if (!user) { window.location.replace('login.php'); return []; }
          const now = new Date();
          let snap = null;
          try {
            snap = await db.collection('appointments')
              .where('patientId', '==', user.uid)
              .where('startAt', '>=', firebase.firestore.Timestamp.fromDate(new Date(now.getTime())))
              .orderBy('startAt', 'asc')
              .get();
          } catch (_) {
            // Fallback without orderBy to avoid composite index; sort client-side
            snap = await db.collection('appointments')
              .where('patientId', '==', user.uid)
              .get();
          }
          const items = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(v => v && v.startAt && v.startAt.toDate && v.startAt.toDate() >= now)
            .filter(v => (String(v.status || '').toLowerCase() !== 'done' && String(v.status || '').toLowerCase() !== 'completed'))
            .sort((a, b) => a.startAt.toDate() - b.startAt.toDate());
          return items;
        }

        function fmt(ts) {
          try { return ts.toDate().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
          catch { return ''; }
        }

        function resolveMeetingUrl(v) {
          return (
            v.meetingUrl || v.meetingLink || v.videoUrl || v.videoLink || v.link || v.roomUrl || v.roomLink || ''
          );
        }

        async function renderAppointments() {
          tableBody.innerHTML = '';
          let items = [];
          try { items = await fetchPatientAppointments(); } catch (_) { items = []; }
          if (!items.length) {
            const row = document.createElement('tr');
            row.innerHTML = '<td colspan="3" class="text-muted">No upcoming appointments</td>';
            tableBody.appendChild(row);
            return;
          }
          items.forEach(v => {
            const row = document.createElement('tr');
            const joinUrl = resolveMeetingUrl(v);
            const actionHtml = joinUrl
              ? `<a href="${joinUrl}" class="btn btn-success btn-sm" target="_blank" rel="noopener">Join Meeting</a>`
              : '<span class="text-muted">No link</span>';
            row.innerHTML = `
              <td>${v.doctorName || 'Doctor'}</td>
              <td>${v.startAt ? fmt(v.startAt) : ''}</td>
              <td>${actionHtml}</td>
            `;
            tableBody.appendChild(row);
          });
        }

        apptBtn.addEventListener('click', async () => {
          await renderAppointments();
          try {
            if (window.bootstrap && window.bootstrap.Modal) {
              const m = window.bootstrap.Modal.getOrCreateInstance(modalEl);
              m.show();
            } else {
              // Bootstrap not available; fallback display
              modalEl.style.display = 'block';
            }
          } catch (_) { /* ignore */ }
        });
      })();
    } catch (err) {
      console.error('Failed to initialize patient directory:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
