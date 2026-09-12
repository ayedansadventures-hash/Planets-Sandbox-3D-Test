export const G = 4 * Math.PI * Math.PI; // ~39.47841760435743 (AU^3 / (M_sun * year^2))
export const EARTHS_PER_SUN = 332946;
export const KM_PER_AU = 149597870.7;
export const AU_YEAR_TO_KM_S = KM_PER_AU / (365.25 * 86400); // ~4.74047 km/s

export function computeAccelerations(bodies) {
  const n = bodies.length;
  const acc = new Array(n);
  for (let i = 0; i < n; i++) acc[i] = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    const aMass = a.mass || 1e-9;
    const aGrav = a.gravityScale ?? a.gravity ?? 1;

    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      const bMass = b.mass || 1e-9;
      const bGrav = b.gravityScale ?? b.gravity ?? 1;

      const dx = b.p[0] - a.p[0];
      const dy = b.p[1] - a.p[1];
      const dz = b.p[2] - a.p[2];

      const distSq = dx * dx + dy * dy + dz * dz;
      // Softening for extreme close encounters to avoid division by zero or numerical explosions
      const r2 = Math.max(distSq, 1e-12);
      const invR = 1 / Math.sqrt(r2);
      const invR3 = invR * invR * invR;

      const pairScale = aGrav * bGrav;
      const factor = G * pairScale * invR3;

      const fAx = factor * bMass * dx;
      const fAy = factor * bMass * dy;
      const fAz = factor * bMass * dz;

      acc[i][0] += fAx;
      acc[i][1] += fAy;
      acc[i][2] += fAz;

      acc[j][0] -= factor * aMass * dx;
      acc[j][1] -= factor * aMass * dy;
      acc[j][2] -= factor * aMass * dz;
    }
  }
  return acc;
}

export function step(bodies, dt) {
  const n = bodies.length;
  if (n === 0) return;

  // 1. Kick: v += a * dt / 2
  const acc1 = computeAccelerations(bodies);
  for (let i = 0; i < n; i++) {
    const b = bodies[i];
    b.prevP = [b.p[0], b.p[1], b.p[2]];
    b.v[0] += acc1[i][0] * dt * 0.5;
    b.v[1] += acc1[i][1] * dt * 0.5;
    b.v[2] += acc1[i][2] * dt * 0.5;

    // 2. Drift: p += v * dt
    b.p[0] += b.v[0] * dt;
    b.p[1] += b.v[1] * dt;
    b.p[2] += b.v[2] * dt;
  }

  // 3. Kick: v += a * dt / 2
  const acc2 = computeAccelerations(bodies);
  for (let i = 0; i < n; i++) {
    const b = bodies[i];
    b.v[0] += acc2[i][0] * dt * 0.5;
    b.v[1] += acc2[i][1] * dt * 0.5;
    b.v[2] += acc2[i][2] * dt * 0.5;

    // Sanitize NaNs
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(b.p[k])) b.p[k] = Number.isFinite(b.prevP[k]) ? b.prevP[k] : 0;
      if (!Number.isFinite(b.v[k])) b.v[k] = 0;
    }
  }
}

export function rocheLimit(primary, secondaryMass, secondaryRadius) {
  if (!primary) return 0;
  const primMass = Math.max(1e-6, primary.mass || 1);
  const secMass = Math.max(1e-9, secondaryMass || 1e-6);
  const secRadius = Math.max(1e-6, secondaryRadius || 0.0001);
  // Rigid body Roche limit: d = 2.44 * R_sec * (M_prim / M_sec)^(1/3)
  return 2.44 * secRadius * Math.cbrt(primMass / secMass);
}

export function computeTidalStress(body, bodies) {
  if (!body || body.type === 'star' || body.type === 'blackhole' || body.tidalImmune) return { stress: 0, primary: null };
  let maxStress = 0;
  let dominantPrimary = null;

  for (const other of bodies) {
    if (other === body) continue;
    if (other.mass < body.mass * 5) continue; // Only significantly more massive bodies exert tidal disruption
    const dx = other.p[0] - body.p[0];
    const dy = other.p[1] - body.p[1];
    const dz = other.p[2] - body.p[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= 0) continue;

    const rLimit = rocheLimit(other, body.mass, (body.radius || 0.36) / 10); // in AU
    const stress = rLimit / Math.max(dist, 1e-5);
    if (stress > maxStress) {
      maxStress = stress;
      dominantPrimary = other;
    }
  }
  return { stress: maxStress, primary: dominantPrimary };
}
