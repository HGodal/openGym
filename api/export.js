/* GET /api/export/v1: the read-only feed another service (the owner's Fitness site) pulls strength
 * data through. The shape is a contract, not the app's internal state: names here are ours, and a
 * change to the stored document must not change them. Additive changes stay in v1.
 *
 * Only the allow-listed fields below leave: no media, settings, plans, push or coach data. */
import crypto from 'node:crypto';
import { LIB_BY_ID } from './coach/core/library.js';

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Whether `header` is `Bearer <token>`, compared in constant time on fixed-length digests. */
export function tokenMatches(header, token) {
  const given = String(header || '');
  if (!token || !given.startsWith('Bearer ')) return false;
  const d = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(d(given.slice(7).trim()), d(token));
}

export function buildExport(S) {
  const custom = new Map((S.customEx || []).map(e => [e.id, e.n]));
  const used = new Set();
  const workouts = (S.workouts || []).map(w => ({
    id: String(w.id),
    date: w.d,
    start: num(w.start),
    end: num(w.end),
    name: w.name ?? null,
    routine_id: w.routineId ?? null,
    body_weight: num(w.bw),
    edited_at: num(w._ts),
    entries: (w.entries || []).map(e => {
      used.add(e.id);
      return {
        exercise_id: String(e.id),
        sets: (e.sets || []).map(s => ({ weight: num(s.w), reps: num(s.r), rpe: num(s.rpe), rir: num(s.rir), done: s.done === true }))
      };
    })
  }));
  return {
    version: 1,
    rev: S._rev || 0,
    unit: S.unit === 'lb' ? 'lb' : 'kg',
    workouts,
    bodyweight: (S.bodyweight || []).map(b => ({ date: b.d, weight: num(b.w) })),
    // Built-in catalogue first, then the profile's own exercises; an id neither knows keeps a null name.
    exercises: [...used].map(id => ({ id: String(id), name: custom.get(id) ?? LIB_BY_ID.get(id)?.n ?? null })),
    // A negative stamp is an add-back after a removal, not a deletion.
    deleted: { workouts: Object.entries(S.deleted?.workouts || {}).filter(([, at]) => at > 0).map(([id, at]) => ({ id, at })) }
  };
}
