/**
 * Tarification du kWh par tranche horaire et par jour de semaine.
 *
 * Module pur (aucun accès BDD) :
 *  - validateTariff()      : validation d'une grille de tarifs d'un site
 *  - resolvePrice()        : prix applicable à un instant local donné
 *  - computeSessionCost()  : coût d'une session (découpe de l'énergie par tranche)
 *
 * Conventions :
 *  - jours ISO : 1 = lundi … 7 = dimanche
 *  - tranche `start_time` → `end_time` au format HH:MM, `end_time` peut valoir 24:00
 *  - tranche avec end < start = passage de minuit ; elle appartient tout entière au jour de
 *    son début (vendredi 22:00→06:00 couvre vendredi 22:00 → samedi 06:00)
 *  - heures non couvertes par une tranche : `default_price_per_kwh`
 *  - grilles datées (`grids`) : la première, sans date, s'applique « depuis l'origine » ; chaque
 *    grille datée s'applique à partir de son jour (`valid_from`, AAAA-MM-JJ, minuit heure du site)
 *    jusqu'à la suivante. Une session à cheval sur deux grilles est découpée à minuit.
 */

const DAY_MS = 86400000;
const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;
const MAX_PRICE = 1000;
const MAX_PERIODS = 50;
const MAX_GRIDS = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAY_TO_ISO = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// ── Codes d'erreur de validation (mappés vers apiErrors côté routes) ──
const ERR = {
  CURRENCY: 'ERR_TARIFF_CURRENCY',
  TIMEZONE: 'ERR_TARIFF_TIMEZONE',
  PRICE: 'ERR_TARIFF_PRICE',
  DEFAULT_REQUIRED: 'ERR_TARIFF_DEFAULT_REQUIRED',
  TIME_FORMAT: 'ERR_TARIFF_TIME_FORMAT',
  TIME_EMPTY: 'ERR_TARIFF_TIME_EMPTY',
  DAYS: 'ERR_TARIFF_DAYS',
  OVERLAP: 'ERR_TARIFF_OVERLAP',
  TOO_MANY: 'ERR_TARIFF_TOO_MANY_PERIODS',
  VALID_FROM: 'ERR_TARIFF_VALID_FROM',
  VALID_FROM_DUPLICATE: 'ERR_TARIFF_VALID_FROM_DUPLICATE',
  TOO_MANY_GRIDS: 'ERR_TARIFF_TOO_MANY_GRIDS',
};

// ── Utilitaires ──

/** "HH:MM" → minutes depuis minuit ; `allow24` autorise "24:00". null si invalide. */
function parseTime(value, allow24 = false) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (h === 24 && min === 0 && allow24) return MINUTES_PER_DAY;
  if (h > 23) return null;
  return h * 60 + min;
}

/** Liste de jours ISO (tableau ou CSV "1,2,3") → tableau trié sans doublon ; null si invalide. */
function parseDays(value) {
  let list;
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string' && value.trim() !== '') list = value.split(',');
  else return null;
  const days = [];
  for (const item of list) {
    const n = typeof item === 'number' ? item : Number(String(item).trim());
    if (!Number.isInteger(n) || n < 1 || n > 7) return null;
    if (!days.includes(n)) days.push(n);
  }
  if (days.length === 0) return null;
  return days.sort((a, b) => a - b);
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Date locale « AAAA-MM-JJ » existante (pas de 2027-02-30) */
function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Grilles d'un tarif, triées : la grille « depuis l'origine » (valid_from null) d'abord, puis par
 * date. Un tarif sans `grids` (forme historique) n'a qu'une grille, depuis l'origine.
 */
function tariffGrids(tariff) {
  const t = tariff || {};
  const grids = Array.isArray(t.grids)
    ? t.grids
    : [{ valid_from: null, default_price_per_kwh: t.default_price_per_kwh, periods: t.periods }];
  return [...grids].sort((a, b) =>
    a.valid_from == null ? -1 : b.valid_from == null ? 1 : a.valid_from.localeCompare(b.valid_from)
  );
}

function isValidPrice(p) {
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= MAX_PRICE;
}

/** Intervalles [début, fin) de la tranche sur la semaine (minutes depuis lundi 00:00). */
function weeklyIntervals(period) {
  const start = parseTime(period.start_time);
  const end = parseTime(period.end_time, true);
  const days = parseDays(period.days);
  const out = [];
  for (const d of days) {
    const base = (d - 1) * MINUTES_PER_DAY;
    if (start < end) {
      out.push([base + start, base + end]);
    } else {
      // passage de minuit : jusqu'à end le lendemain (avec rebouclage dimanche → lundi)
      const from = base + start;
      const to = base + MINUTES_PER_DAY + end;
      if (to <= MINUTES_PER_WEEK) {
        out.push([from, to]);
      } else {
        out.push([from, MINUTES_PER_WEEK]);
        out.push([0, to - MINUTES_PER_WEEK]);
      }
    }
  }
  return out;
}

/**
 * Valide une grille de tarifs.
 * @returns {{valid: boolean, errors: Array<{code: string, index?: number, other?: number}>}}
 */
function validateTariff(tariff) {
  const errors = [];
  const t = tariff || {};

  if (typeof t.currency !== 'string' || !/^[A-Z]{3}$/.test(t.currency)) {
    errors.push({ code: ERR.CURRENCY });
  }
  if (!isValidTimezone(t.timezone)) errors.push({ code: ERR.TIMEZONE });

  if (!Array.isArray(t.grids)) {
    validateGrid(t, errors);
    return { valid: errors.length === 0, errors };
  }
  if (t.grids.length > MAX_GRIDS) errors.push({ code: ERR.TOO_MANY_GRIDS });
  const seen = new Set();
  t.grids.slice(0, MAX_GRIDS).forEach((g, grid) => {
    const from = g ? g.valid_from : undefined;
    // Exactement une grille « depuis l'origine », la première ; les autres datées et distinctes
    if (grid === 0 ? from != null : !isValidDate(from)) {
      errors.push({ code: ERR.VALID_FROM, grid });
    } else if (from != null) {
      if (seen.has(from)) errors.push({ code: ERR.VALID_FROM_DUPLICATE, grid });
      seen.add(from);
    }
    validateGrid(g || {}, errors, grid);
  });
  return { valid: errors.length === 0, errors };
}

// Une grille : prix par défaut + tranches (`grid` = rang de la grille, ajouté aux erreurs)
function validateGrid(t, errors, grid) {
  const push = (e) => errors.push(grid === undefined ? e : { ...e, grid });
  const periods = Array.isArray(t.periods) ? t.periods : [];
  const hasDefault = t.default_price_per_kwh !== null && t.default_price_per_kwh !== undefined;
  if (hasDefault && !isValidPrice(t.default_price_per_kwh)) {
    push({ code: ERR.PRICE });
  }
  if (periods.length > 0 && !hasDefault) push({ code: ERR.DEFAULT_REQUIRED });
  if (periods.length > MAX_PERIODS) push({ code: ERR.TOO_MANY });

  const wellFormed = [];
  periods.slice(0, MAX_PERIODS).forEach((p, index) => {
    let ok = true;
    const start = parseTime(p && p.start_time);
    const end = parseTime(p && p.end_time, true);
    if (start === null || end === null) {
      push({ code: ERR.TIME_FORMAT, index });
      ok = false;
    } else if (start === end) {
      push({ code: ERR.TIME_EMPTY, index });
      ok = false;
    }
    if (parseDays(p && p.days) === null) {
      push({ code: ERR.DAYS, index });
      ok = false;
    }
    if (!isValidPrice(p && p.price_per_kwh)) {
      push({ code: ERR.PRICE, index });
      ok = false;
    }
    if (ok) wellFormed.push({ index, intervals: weeklyIntervals(p) });
  });

  // Chevauchement entre tranches (en tenant compte du report après minuit)
  for (let i = 0; i < wellFormed.length; i++) {
    for (let j = i + 1; j < wellFormed.length; j++) {
      const overlap = wellFormed[i].intervals.some(([a1, b1]) =>
        wellFormed[j].intervals.some(([a2, b2]) => a1 < b2 && a2 < b1)
      );
      if (overlap) {
        push({ code: ERR.OVERLAP, index: wellFormed[i].index, other: wellFormed[j].index });
      }
    }
  }
}

// ── Résolution du prix ──

/** Normalise les tranches (minutes + tableau de jours) pour le calcul. */
function normalizePeriods(periods) {
  const out = [];
  for (const p of periods || []) {
    const start = parseTime(p.start_time);
    const end = parseTime(p.end_time, true);
    const days = parseDays(p.days);
    if (start === null || end === null || start === end || days === null) continue;
    const price = Number(p.price_per_kwh);
    if (!Number.isFinite(price)) continue;
    out.push({
      label: p.label || `${p.start_time}-${p.end_time}`,
      start,
      end,
      days,
      price,
    });
  }
  return out;
}

/**
 * Prix applicable à un jour ISO + minute locale.
 * @param {Array} periods tranches normalisées (normalizePeriods)
 * @param {number|null} defaultPrice prix des heures non couvertes
 * @returns {{price: number, label: string|null}}
 */
function resolvePrice(periods, isoDay, minute, defaultPrice) {
  const prevDay = isoDay === 1 ? 7 : isoDay - 1;
  for (const p of periods) {
    if (p.start < p.end) {
      if (p.days.includes(isoDay) && minute >= p.start && minute < p.end) {
        return { price: p.price, label: p.label };
      }
    } else if (
      (p.days.includes(isoDay) && minute >= p.start) ||
      (p.days.includes(prevDay) && minute < p.end)
    ) {
      return { price: p.price, label: p.label };
    }
  }
  return { price: defaultPrice, label: null };
}

const formatterCache = new Map();
function getFormatter(timezone) {
  let f = formatterCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, f);
  }
  return f;
}

/**
 * Jour ISO, ms écoulées depuis minuit local et décalage UTC (ms) pour un instant (ms epoch).
 * Le décalage permet de détecter un changement d'heure (DST) entre deux instants.
 */
function localParts(timezone, tMs) {
  const parts = getFormatter(timezone).formatToParts(new Date(tMs));
  const v = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  let weekday = 'Mon';
  for (const part of parts) {
    if (part.type === 'weekday') weekday = part.value;
    else if (part.type in v) v[part.type] = Number(part.value);
  }
  v.hour %= 24;
  const msInSecond = ((tMs % 1000) + 1000) % 1000;
  const localAsUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${v.year}-${pad(v.month)}-${pad(v.day)}`,
    isoDay: WEEKDAY_TO_ISO[weekday] || 1,
    msOfDay: ((v.hour * 60 + v.minute) * 60 + v.second) * 1000 + msInSecond,
    offset: localAsUtc - (tMs - msInSecond),
  };
}

// ── Calcul du coût d'une session ──

const round = (n, decimals) => {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/**
 * Courbe d'énergie cumulée de la session : [{t (ms), e (kWh)}], croissante et bornée.
 * Points : [(start, 0), ...mesures intermédiaires, (stop, totalKwh)].
 */
function buildCurve(startMs, stopMs, totalKwh, points) {
  const curve = [{ t: startMs, e: 0 }];
  const inter = [];
  for (const p of Array.isArray(points) ? points : []) {
    if (!p) continue;
    const x = Number(p.x);
    const wh = Number(p.energy);
    if (!Number.isFinite(x) || !Number.isFinite(wh)) continue;
    const t = Math.round(x * 1000);
    if (t <= startMs || t >= stopMs) continue;
    inter.push({ t, e: Math.max(0, wh) / 1000 });
  }
  inter.sort((a, b) => a.t - b.t);
  let last = 0;
  for (const p of inter) {
    // énergie monotone et bornée par l'énergie totale de la session
    const e = Math.min(Math.max(p.e, last), totalKwh);
    last = e;
    if (curve[curve.length - 1].t === p.t) curve[curve.length - 1].e = e;
    else curve.push({ t: p.t, e });
  }
  curve.push({ t: stopMs, e: totalKwh });
  return { curve, intermediateCount: curve.length - 2 };
}

/**
 * Calcule le coût d'une session.
 * @param {object} input
 * @param {string} input.startTime  ISO 8601
 * @param {string} input.stopTime   ISO 8601
 * @param {number} input.totalKwh   énergie totale de la session
 * @param {Array}  [input.points]   [{x: unixSec, energy: Wh relatif au début}] (MeterValues)
 * @param {object} input.tariff     {currency, timezone, default_price_per_kwh, periods[]}
 * @returns {{cost: number, currency: string, details: object}|null} null si pas de tarif
 */
function computeSessionCost({ startTime, stopTime, totalKwh, points, tariff }) {
  if (!tariff) return null;
  // Grilles normalisées ; une grille sans prix par défaut = pas de tarif à partir de sa date
  const grids = tariffGrids(tariff).map((g) => {
    const raw = g.default_price_per_kwh;
    const price = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    return {
      validFrom: g.valid_from ?? null,
      defaultPrice: Number.isFinite(price) ? price : null,
      periods: normalizePeriods(g.periods),
    };
  });
  if (!grids.some((g) => g.defaultPrice !== null)) return null;
  const gridFor = (date) => {
    let found = grids[0];
    for (const g of grids) if (g.validFrom === null || g.validFrom <= date) found = g;
    return found;
  };
  const kwhTotal = Number(totalKwh);
  if (!Number.isFinite(kwhTotal) || kwhTotal < 0) return null;

  const startMs = Date.parse(startTime);
  let stopMs = Date.parse(stopTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) return null;
  if (stopMs < startMs) stopMs = startMs;

  const timezone = isValidTimezone(tariff.timezone) ? tariff.timezone : 'UTC';
  const currency = tariff.currency || 'EUR';

  // Bornes de tranches dans la journée (ms depuis minuit local), toutes grilles confondues :
  // chaque morceau reste dans une seule journée locale, donc une seule grille
  const boundarySet = new Set([0, DAY_MS]);
  for (const g of grids) {
    for (const p of g.periods) {
      boundarySet.add(p.start * 60000);
      boundarySet.add(p.end * 60000);
    }
  }
  const boundaries = [...boundarySet].sort((a, b) => a - b);

  const segments = [];
  let unpriced = false;
  const pushSegment = (fromMs, toMs, kwh) => {
    const { date, isoDay, msOfDay } = localParts(timezone, fromMs);
    const grid = gridFor(date);
    if (grid.defaultPrice === null) {
      // énergie consommée un jour sans tarif : coût incalculable
      if (kwh > 1e-9) unpriced = true;
      return;
    }
    const { price, label } = resolvePrice(
      grid.periods,
      isoDay,
      Math.floor(msOfDay / 60000),
      grid.defaultPrice
    );
    const from = grid.validFrom;
    const last = segments[segments.length - 1];
    if (last && last.price === price && last.label === label && last.validFrom === from) {
      last.to = toMs;
      last.kwh += kwh;
      last.amount += kwh * price;
    } else {
      segments.push({
        from: fromMs,
        to: toMs,
        label,
        price,
        kwh,
        amount: kwh * price,
        validFrom: from,
      });
    }
  };

  const { curve, intermediateCount } = buildCurve(startMs, stopMs, kwhTotal, points);

  if (stopMs === startMs) {
    // Session instantanée : toute l'énergie au prix de l'instant
    pushSegment(startMs, stopMs, kwhTotal);
  } else {
    for (let i = 0; i < curve.length - 1; i++) {
      const a = curve[i];
      const b = curve[i + 1];
      const span = b.t - a.t;
      const dE = b.e - a.e;
      let t = a.t;
      while (t < b.t) {
        const here = localParts(timezone, t);
        const next = boundaries.find((x) => x > here.msOfDay) ?? DAY_MS;
        let tNext = Math.min(b.t, t + (next - here.msOfDay));
        if (localParts(timezone, tNext).offset !== here.offset) {
          // Changement d'heure avant la borne locale : on s'arrête à l'instant exact de la bascule
          let lo = t;
          let hi = tNext;
          while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (localParts(timezone, mid).offset === here.offset) lo = mid;
            else hi = mid;
          }
          tNext = hi;
        }
        const kwh = span > 0 ? ((tNext - t) / span) * dE : 0;
        pushSegment(t, tNext, kwh);
        t = tNext;
      }
    }
  }

  if (unpriced) return null;
  const kept = segments.filter((s) => s.kwh > 1e-9);
  const total = kept.reduce((sum, s) => sum + s.amount, 0);
  const startGrid = gridFor(localParts(timezone, startMs).date);

  return {
    cost: round(total, 2),
    currency,
    details: {
      method: intermediateCount > 0 ? 'meter' : 'prorata',
      timezone,
      total_kwh: round(kwhTotal, 6),
      default_price: startGrid.defaultPrice,
      segments: kept.map((s) => ({
        from: new Date(s.from).toISOString(),
        to: new Date(s.to).toISOString(),
        label: s.label,
        kwh: round(s.kwh, 6),
        price: s.price,
        amount: round(s.amount, 6),
        // grille datée appliquée (absente pour la grille « depuis l'origine »)
        ...(s.validFrom ? { tariff_from: s.validFrom } : {}),
      })),
    },
  };
}

/**
 * Courbe d'énergie à partir du détail d'un coût figé (cost_details), quand les relevés de la
 * session ont été purgés : un point en fin de chaque morceau, énergie cumulée en Wh.
 * Recalculer avec une autre grille garde ainsi la répartition horaire d'origine.
 */
function pointsFromCostDetails(details) {
  let d = details;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return [];
    }
  }
  if (!d || !Array.isArray(d.segments)) return [];
  const points = [];
  let cumulative = 0;
  for (const seg of d.segments) {
    cumulative += Number(seg.kwh) || 0;
    const t = Date.parse(seg.to);
    if (Number.isFinite(t)) points.push({ x: t / 1000, energy: cumulative * 1000 });
  }
  return points;
}

/**
 * Nettoie le corps d'une requête PUT /sites/:id/tariff avant validation.
 * @returns {object|null} null si le corps n'a pas la forme attendue
 */
function normalizeTariffInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.grids !== undefined && !Array.isArray(body.grids)) return null;
  const head = {
    currency:
      typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : body.currency,
    timezone: typeof body.timezone === 'string' ? body.timezone.trim() : body.timezone,
  };
  if (Array.isArray(body.grids)) {
    const grids = [];
    for (const g of body.grids) {
      const grid = normalizeGridInput(g);
      if (!grid) return null;
      grids.push({
        valid_from:
          g.valid_from === null || g.valid_from === undefined || g.valid_from === ''
            ? null
            : typeof g.valid_from === 'string'
              ? g.valid_from.trim()
              : g.valid_from,
        ...grid,
      });
    }
    return { ...head, grids };
  }
  const grid = normalizeGridInput(body);
  return grid ? { ...head, ...grid } : null;
}

// Prix par défaut + tranches d'une grille (corps de requête), avant validation
function normalizeGridInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.periods !== undefined && !Array.isArray(body.periods)) return null;
  const rawDefault = body.default_price_per_kwh;
  const hasDefault = rawDefault !== null && rawDefault !== undefined && rawDefault !== '';
  return {
    default_price_per_kwh: hasDefault ? Number(rawDefault) : null,
    periods: (body.periods || []).map((p) => {
      const period = p && typeof p === 'object' ? p : {};
      const days = parseDays(period.days);
      return {
        label: typeof period.label === 'string' ? period.label.trim().slice(0, 50) || null : null,
        days: days ? days.join(',') : period.days,
        start_time: period.start_time,
        end_time: period.end_time,
        price_per_kwh:
          period.price_per_kwh === '' || period.price_per_kwh === null
            ? NaN
            : Number(period.price_per_kwh),
      };
    }),
  };
}

/**
 * Résumé texte du détail d'un coût figé (colonne CSV « tariff_detail »).
 * Les segments de même libellé et même prix sont fusionnés.
 * Ex. : "HP 6.20 kWh × 0.2500 = 1.55 | HC 12.00 kWh × 0.1500 = 1.80"
 * @param {string|object|null} details cost_details (JSON ou objet)
 * @param {string} defaultLabel libellé des heures sans tranche (prix par défaut)
 */
function formatTariffDetail(details, defaultLabel = 'default') {
  let d = details;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return '';
    }
  }
  if (!d || !Array.isArray(d.segments)) return '';
  const merged = new Map();
  for (const seg of d.segments) {
    const label = seg.label || defaultLabel;
    const key = `${label} ${seg.price}`;
    const m = merged.get(key) || { label, price: seg.price, kwh: 0, amount: 0 };
    m.kwh += seg.kwh;
    m.amount += seg.amount;
    merged.set(key, m);
  }
  return [...merged.values()]
    .map(
      (m) => `${m.label} ${m.kwh.toFixed(2)} kWh × ${m.price.toFixed(4)} = ${m.amount.toFixed(2)}`
    )
    .join(' | ');
}

module.exports = {
  normalizeTariffInput,
  formatTariffDetail,
  ALL_DAYS,
  ERR,
  isValidDate,
  tariffGrids,
  pointsFromCostDetails,
  parseTime,
  parseDays,
  isValidTimezone,
  validateTariff,
  normalizePeriods,
  resolvePrice,
  computeSessionCost,
};
