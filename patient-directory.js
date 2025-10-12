(function () {
  'use strict';

  // Prevent double-initialization if the script is accidentally included twice
  if (window.__techmedPatientDirectoryLoaded) return;
  window.__techmedPatientDirectoryLoaded = true;

  // Will be set once Firebase is ready
  let db;

  // Small helper: wait for a condition (Firebase/lib readiness)
  async function waitUntil(checkFn, { timeoutMs = 10000, intervalMs = 50 } = {}) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      (function poll() {
        try {
          if (checkFn()) return resolve(true);
        } catch (_) { /* ignore */ }
        if (Date.now() - start >= timeoutMs) return reject(new Error('timeout'));
        setTimeout(poll, intervalMs);
      })();
    });
  }

  // DOM elements (optional on some pages)
  const swiperEl = document.querySelector('.swiper');
  const swiperWrapper = document.querySelector('.swiper .swiper-wrapper');
  const directoryContainer = document.querySelector('.doctor-directory .isotope-container');

  // Profile area
  const profileImgEl = document.getElementById('doctor-image');
  const profileNameEl = document.getElementById('doctor-name');
  const profileSpecEl = document.getElementById('doctor-specialty');
  const profileBioEl = document.getElementById('doctor-bio');
  const scheduleGridEl = document.getElementById('doctor-schedule');

  // Appointment form elements
  const form = document.getElementById('appointment-form');
  const doctorInput = document.getElementById('doctorInput');
  const doctorIdHidden = document.getElementById('doctorIdHidden');
  const dateInput = document.getElementById('dateInput');
  const timeSelect = document.getElementById('timeSelect');

  // Keep flatpickr instance per doctor selection
  let calendarInstance = null;
  let calendarLibTries = 0;
  let currentSelectedDoctorId = null;

  // URL doctorId preselection
  const urlDoctorId = new URL(window.location.href).searchParams.get('doctorId');

  // Cache monthly bookings per doctor to minimize reads
  // Key: `${doctorId}|YYYY-MM` -> Map<YYYY-MM-DD, Set<number(ms)>>
  const monthlyBookingsCache = new Map();
  // Cache daily availability overrides per doctor per month
  // Key: `${doctorId}|YYYY-MM` -> Map<YYYY-MM-DD, { slots?: string[], startHour?: string, endHour?: string, slotMinutes?: number, off?: boolean }>
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
    // Expects time as minutes from midnight
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
      if (mins != null && mins % 60 === 0) out.push(hhmm); // only on-the-hour times
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
    // already HH:MM
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

    // Collect weekly shapes from possible fields
    let weekly = top.weeklySchedule || schedTop.weeklySchedule || top.availability || schedTop.availability || top.scheduleByDay || schedTop.scheduleByDay || top.hoursByDay || schedTop.hoursByDay || top.byDay || schedTop.byDay || top.days || schedTop.days || top.slotsByDay || schedTop.slotsByDay || top.timesByDay || schedTop.timesByDay;
    // If not provided explicitly, treat schedule object itself as a day map
    if (!weekly && looksLikeDayMap(schedTop)) {
      weekly = schedTop;
    }

    const byDay = {};
    const wdSet = new Set(Array.isArray(schedule.workingDays) ? schedule.workingDays : []);

    // Case 1: Array of entries
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
    }

    // Case 2: Object map keyed by day name/index -> range or {start,end}
    else if (weekly && typeof weekly === 'object') {
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

    // Defaults
    if (!schedule.startHour) schedule.startHour = '09:00';
    if (!schedule.endHour) schedule.endHour = '17:00';
    if (!schedule.slotMinutes) schedule.slotMinutes = 30;

    return schedule;
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function endOfDay(date) {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  async function withTimeout(promise, ms, fallback) {
    let to;
    try {
      const timeout = new Promise((_, rej) => { to = setTimeout(() => rej(new Error('timeout')), ms); });
      const result = await Promise.race([promise, timeout]);
      clearTimeout(to);
      return result;
    } catch (_) {
      clearTimeout(to);
      return typeof fallback === 'function' ? fallback() : fallback;
    }
  }

  function defaultSchedule() {
    // Used only for default slotMinutes; do not impose default working days/hours
    return {
      workingDays: [],
      startHour: undefined,
      endHour: undefined,
      slotMinutes: 30,
    };
  }

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
    const fallback = defaultSchedule();
    const sched = schedule || fallback;
    const byDay = sched.byDay || {};
    const dayOverride = byDay[dayIndex];
    return {
      startHour: (dayOverride && dayOverride.startHour) || sched.startHour || fallback.startHour,
      endHour: (dayOverride && dayOverride.endHour) || sched.endHour || fallback.endHour,
      slotMinutes: parseInt(sched.slotMinutes || fallback.slotMinutes, 10) || fallback.slotMinutes,
      slotList: dayOverride && Array.isArray(dayOverride.slots) ? dayOverride.slots : undefined,
    };
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
    const startMin = parseHHMM(eff.startHour);
    const endMin = parseHHMM(eff.endHour);
    const step = 60; // only hourly increments
    for (let t = startMin; t + step <= endMin; t += step) {
      const slotDate = new Date(date);
      const hours = Math.floor(t / 60);
      const minutes = t % 60;
      slotDate.setHours(hours, minutes, 0, 0);
      slots.push(slotDate);
    }
    return slots;
  }

  async function buildSlotsForDateWithDaily(doctor, date) {
    const daily = await getDailyOverride(doctor.id, date);
    const slots = [];
    if (daily) {
      if (daily.off) return slots;
      const step = 60; // only hourly increments
      if (daily.slots && daily.slots.length) {
        for (const hhmm of daily.slots) {
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
      if (daily.startHour && daily.endHour) {
        const startMin = parseHHMM(daily.startHour);
        const endMin = parseHHMM(daily.endHour);
        for (let t = startMin; t + step <= endMin; t += step) {
          const slotDate = new Date(date);
          const hours = Math.floor(t / 60);
          const minutes = t % 60;
          slotDate.setHours(hours, minutes, 0, 0);
          slots.push(slotDate);
        }
        return slots;
      }
      return slots;
    }
    return buildSlotsForDate(date, doctor.schedule || {});
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

  function hasOpenSlotsFromCache(doctor, date) {
    const ymd = formatYMD(date);
    const mk = `${doctor.id}|${monthKey(date)}`;
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
      // weekly/general schedule
      const wd = getWorkingDays(doctor);
      if (!wd.includes(date.getDay())) return false;
      const by = doctor.schedule && doctor.schedule.byDay ? doctor.schedule.byDay[date.getDay()] : null;
      const startHH = (by && by.startHour) || (doctor.schedule && doctor.schedule.startHour);
      const endHH = (by && by.endHour) || (doctor.schedule && doctor.schedule.endHour);
      if (!startHH || !endHH) return false;
      candidate = buildHourlySlots(date, startHH, endHH);
    }

    // filter past if today
    if (isSameDay(date, new Date())) {
      candidate = filterPastSlots(candidate);
    }
    for (const s of candidate) {
      if (!bookedSet.has(s.getTime())) return true;
    }
    return false;
  }

  function filterPastSlots(slots) {
    const now = new Date();
    return slots.filter(d => d.getTime() > now.getTime());
  }

  async function fetchDoctorById(doctorId) {
    const doc = await db.collection('public_doctors').doc(doctorId).get();
    if (!doc.exists) return null;
    const data = doc.data() || {};

    const schedule = extractScheduleFromData(data);

    return {
      id: doc.id,
      name: data.name || data.fullName || 'Doctor',
      specialty: data.specialty || data.department || data.title || '',
      bio: data.bio || data.about || '',
      photoUrl: data.photoUrl || data.photo || data.image || data.avatarUrl || '',
      reviews: data.reviews || data.review || '',
      schedule,
    };
  }

  async function prefetchMonthBookings(doctorId, year, monthIndex /* 0-based */) {
    const first = new Date(year, monthIndex, 1, 0, 0, 0, 0);
    const last = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
    const mKey = `${doctorId}|${monthKey(first)}`;
    if (monthlyBookingsCache.has(mKey)) return monthlyBookingsCache.get(mKey);

    const snap = await db.collection('appointments')
      .where('doctorId', '==', doctorId)
      .where('startAt', '>=', firebase.firestore.Timestamp.fromDate(first))
      .where('startAt', '<=', firebase.firestore.Timestamp.fromDate(last))
      .get();

    const dayToSet = new Map();
    snap.forEach(d => {
      const v = d.data();
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
    let startHour = coerceHHMM(v.start || v.startHour);
    let endHour = coerceHHMM(v.end || v.endHour);
    if ((!startHour || !endHour) && (v.time || v.range || v.hours)) {
      const r = parseAnyRangeToHHMM(v.time || v.range || v.hours);
      startHour = startHour || r?.startHour;
      endHour = endHour || r?.endHour;
    }
    const slotMinutes = parseInt(v.slotMinutes, 10) || undefined;
    if (off) return { off: true };
    if (!slots && (!startHour || !endHour)) return null;
    return { slots, startHour, endHour, slotMinutes };
  }

  async function prefetchMonthDailyAvailability(doctorId, year, monthIndex /* 0-based */) {
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
    } catch {
      // ignore
    }

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
      // Fallback when 'name' field missing or unindexed
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
    // Avoid double-init
    if (swiperEl && swiperEl.swiper) return;
    if (typeof Swiper === 'undefined') {
      if (swiperInitTries++ < 60) setTimeout(ensureSwiperInitialized, 100);
      return;
    }
    // eslint-disable-next-line no-new
    new Swiper(swiperEl, {
      slidesPerView: 2,
      spaceBetween: 15,
      navigation: {
        nextEl: '.swiper-button-next',
        prevEl: '.swiper-button-prev',
      },
      pagination: { el: '.swiper-pagination', clickable: true },
      breakpoints: {
        768: { slidesPerView: 3 },
        992: { slidesPerView: 4 },
        1200: { slidesPerView: 5 },
      },
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

    // Initialize or retry initializing Swiper once slides are in the DOM
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
            <img src="${doc.photoUrl || 'logo.png'}" class="img-fluid" alt="${doc.name}" loading="lazy">
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
      // Retry briefly until flatpickr is available
      if (calendarLibTries++ < 60) setTimeout(() => initCalendarForDoctor(doctor), 100);
      return;
    }

    destroyCalendarIfAny();

    const workingDays = getWorkingDays(doctor);
    try {
      const now = new Date();
      await Promise.all([
        prefetchMonthBookings(doctor.id, now.getFullYear(), now.getMonth()),
        prefetchMonthDailyAvailability(doctor.id, now.getFullYear(), now.getMonth()),
      ]);
    } catch {}

    calendarInstance = flatpickr(dateInput, {
      altInput: false,
      dateFormat: 'Y-m-d',
      minDate: 'today',
      inline: true,
      disableMobile: true,
      disable: [
        function (d) {
          // Disable dates that do not have any open slots
          return !hasOpenSlotsFromCache(doctor, d);
        },
      ],
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
      onDayCreate: async function (dObj, dStr, fp, dayElem) {
        try {
          const d = dayElem.dateObj || (dStr ? new Date(`${dStr}T00:00:00`) : null);
          if (!d || isNaN(d.getTime())) return;
          // Clear previous markers
          dayElem.classList.remove('available', 'booked', 'semi-disabled');
          // If Flatpickr already disabled this date (no schedule or past month), keep it grey
          if (dayElem.classList.contains('flatpickr-disabled') || dayElem.classList.contains('disabled')) {
            dayElem.classList.add('semi-disabled');
            return;
          }
          // Only mark green when open slots exist; else red

          const mk = `${doctor.id}|${monthKey(d)}`;
          const map = monthlyBookingsCache.get(mk);
          const bookedSet = map ? (map.get(formatYMD(d)) || new Set()) : new Set();

          const allSlots = await buildSlotsForDateWithDaily(doctor, d);
          const today = new Date();
          const todayStart = new Date(); todayStart.setHours(0,0,0,0);
          const dateStart = new Date(d); dateStart.setHours(0,0,0,0);

          if (allSlots.length === 0) {
            // No schedule for this day (unavailable)
            dayElem.classList.add('semi-disabled');
            return;
          }

          // Past day
          if (dateStart < todayStart) {
            dayElem.classList.add('semi-disabled');
            return;
          }

          const effectiveSlots = isSameDay(d, today) ? filterPastSlots(allSlots) : allSlots;
          if (effectiveSlots.length === 0) {
            // Today but all in the past
            dayElem.classList.add('semi-disabled');
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
      onChange: function (selectedDates) {
        const d = selectedDates && selectedDates[0] ? selectedDates[0] : null;
        if (d) {
          populateTimesForDate(doctor, d);
        }
      },
    });
  }

  async function fetchBookedForDay(doctorId, date) {
    try {
      return await getBookedSetForDayFromCacheOrFetch(doctorId, date);
    } catch (e) {
      return new Set();
    }
  }

  async function populateTimesForDate(doctor, date) {
    if (!timeSelect) return;

    timeSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      const baseSlots = await withTimeout(
        buildSlotsForDateWithDaily(doctor, date),
        2000,
        () => buildSlotsForDate(date, doctor.schedule || {})
      );
      const slots = startOfDay(date).toDateString() === new Date().toDateString()
        ? filterPastSlots(baseSlots)
        : baseSlots;

      const booked = await withTimeout(fetchBookedForDay(doctor.id, date), 1500, new Set());
      const available = slots.filter(d => !booked.has(d.getTime()));

      timeSelect.innerHTML = '<option value="">Select Time</option>';
      available.forEach(d => {
        const hours = d.getHours();
        const minutes = d.getMinutes();
        const valueMinutes = hours * 60 + minutes;
        const label = to12h(valueMinutes);
        const opt = document.createElement('option');
        opt.value = label;
        opt.textContent = label;
        timeSelect.appendChild(opt);
      });

      if (available.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No times available';
        timeSelect.appendChild(opt);
      } else {
        // Preselect first available time
        timeSelect.selectedIndex = 1;
      }
    } catch (e) {
      timeSelect.innerHTML = '<option value="">No times available</option>';
    }
  }

  async function selectDoctor(doctor) {
    if (currentSelectedDoctorId === doctor.id) return;
    if (doctorInput) doctorInput.value = doctor.name;
    if (doctorIdHidden) {
      // Only set the input's value property; avoid mutating the attribute to prevent observer loops
      doctorIdHidden.value = doctor.id;
    }
    currentSelectedDoctorId = doctor.id;

    updateProfileView(doctor);
    renderWeeklySchedule(doctor);
    initCalendarForDoctor(doctor);

    // If a date is already selected, repopulate times
    if (calendarInstance && calendarInstance.selectedDates?.length) {
      await populateTimesForDate(doctor, calendarInstance.selectedDates[0]);
    } else if (dateInput && dateInput.value) {
      const d = new Date(dateInput.value);
      if (!isNaN(d.getTime())) await populateTimesForDate(doctor, d);
    } else {
      // Auto-select the next available date/time if nothing is selected
      const pick = await findNextAvailableSlot(doctor, new Date());
      if (pick) {
        if (calendarInstance) calendarInstance.setDate(pick.date, true);
        await populateTimesForDate(doctor, pick.date);
        // timeSelect will have options now; pick the one matching pick.timeLabel
        if (timeSelect) {
          const opt = Array.from(timeSelect.options).find(o => o.value === pick.timeLabel);
          if (opt) timeSelect.value = pick.timeLabel;
        }
      }
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

    // If byDay exists, render only those days in weekday order
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
        const sMin = dConf.startHour ? parseHHMM(dConf.startHour) : null;
        const eMin = dConf.endHour ? parseHHMM(dConf.endHour) : null;
        range = `${sMin != null ? to12h(sMin) : ''}${sMin != null && eMin != null ? ' - ' : ''}${eMin != null ? to12h(eMin) : ''}`;
      } else if (sched.startHour && sched.endHour) {
        const sMin = parseHHMM(sched.startHour);
        const eMin = parseHHMM(sched.endHour);
        range = `${to12h(sMin)} - ${to12h(eMin)}`;
      }
      html += `
        <div class="col-6 col-md-4">
          <div class="border rounded p-2 h-100">
            <div class="fw-semibold">${DAY_NAMES[i]}</div>
            <div class="small">${range || '—'}</div>
          </div>
        </div>`;
    });
    html += '</div>';
    scheduleGridEl.innerHTML = html;
  }

  async function findNextAvailableSlot(doctor, fromDate) {
    const limitDays = 60; // safety bound
    const start = startOfDay(fromDate);
    for (let i = 0; i < limitDays; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const wd = d.getDay();
      if (!getWorkingDays(doctor).includes(wd)) continue;
      let allSlots = [];
      try {
        allSlots = await buildSlotsForDateWithDaily(doctor, d);
      } catch {}
      const today = new Date();
      const effectiveSlots = isSameDay(d, today) ? filterPastSlots(allSlots) : allSlots;
      if (effectiveSlots.length === 0) continue;
      const booked = await getBookedSetForDayFromCacheOrFetch(doctor.id, d);
      const open = effectiveSlots.filter(s => !booked.has(s.getTime()));
      if (open.length > 0) {
        const first = open[0];
        const label = to12h(first.getHours() * 60 + first.getMinutes());
        return { date: d, timeLabel: label };
      }
    }
    return null;
  }

  function attachSelectionHandlers(doctorsById) {
    const root = document;
    root.addEventListener('click', async (e) => {
      // 1) Old select button support
      const btn = e.target.closest('.select-doctor');
      if (btn) {
        const card = btn.closest('[data-doctor-id]');
        const id = card && card.getAttribute('data-doctor-id');
        if (!id) return;
        const doc = doctorsById.get(id);
        if (!doc) return;
        await selectDoctor(doc);
        return;
      }

      // 2) Minimal-card click selection
      const minCard = e.target.closest('.minimal-card');
      if (minCard) {
        const id = minCard.getAttribute('data-doctor-id');
        if (!id) return;
        const doc = doctorsById.get(id);
        if (!doc) return;
        // Toggle active state
        document.querySelectorAll('.minimal-card.active').forEach(el => el.classList.remove('active'));
        minCard.classList.add('active');
        await selectDoctor(doc);
        return;
      }

      // 3) Directory "Book Appointment" button
      const bookBtn = e.target.closest('.btn-appointment');
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

      // 4) Directory "View Profile" button
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

      // no-op
    });
  }

  async function bootstrap() {
    try {
      // Ensure Firebase is initialized before using Firestore
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

      // In case Swiper loads after this script, attempt one more init on window load
      window.addEventListener('load', ensureSwiperInitialized, { once: true });

      const doctorsById = new Map(doctors.map(d => [d.id, d]));
      attachSelectionHandlers(doctorsById);

      // Preselect via URL doctorId
      if (urlDoctorId && doctorsById.has(urlDoctorId)) {
        await selectDoctor(doctorsById.get(urlDoctorId));
      }
      // If no URL id but form already has a doctor id/name, hydrate selection
      else if (doctorIdHidden && doctorIdHidden.value && doctorsById.has(doctorIdHidden.value)) {
        await selectDoctor(doctorsById.get(doctorIdHidden.value));
      } else if (doctorInput && doctorInput.value) {
        const match = doctors.find(d => d.name === doctorInput.value);
        if (match) await selectDoctor(match);
      }

      // If a doctor is selected later via some external script, observe changes to hidden id
      if (doctorIdHidden) {
        const obs = new MutationObserver(async () => {
          const idAttr = doctorIdHidden.getAttribute('value');
          // Only react if an external script changed the attribute to a new id
          if (idAttr && idAttr !== currentSelectedDoctorId && doctorsById.has(idAttr)) {
            await selectDoctor(doctorsById.get(idAttr));
          }
        });
        obs.observe(doctorIdHidden, { attributes: true, attributeFilter: ['value'] });
      }

      // If the date changes (even outside flatpickr), repopulate times if a doctor is chosen
      if (dateInput) {
        dateInput.addEventListener('change', async () => {
          const id = doctorIdHidden && doctorIdHidden.value;
          if (!id || !dateInput.value) return;
          const doctor = await fetchDoctorById(id);
          if (!doctor) return;
          const d = new Date(dateInput.value);
          if (!isNaN(d.getTime())) await populateTimesForDate(doctor, d);
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to initialize patient directory:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
