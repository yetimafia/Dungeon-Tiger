// Dice: "2d6+3", "1d8 + MOD", "3d4+3", "10". crit doubles the dice (not the bonus).
export const d = (sides) => 1 + Math.floor(Math.random() * sides);
export const d20 = (adv = 0) => {
  const a = d(20), b = d(20);
  return adv > 0 ? Math.max(a, b) : adv < 0 ? Math.min(a, b) : a;
};

export function roll(expr, { mod = 0, crit = false } = {}) {
  let total = 0;
  const parts = [];
  const s = String(expr || '0').replace(/MOD/gi, String(mod)).replace(/\s+/g, '').replace(/−/g, '-');
  for (const m of s.matchAll(/([+-]?)(\d*)d(\d+)|([+-]?\d+)/g)) {
    if (m[3]) {
      const sign = m[1] === '-' ? -1 : 1;
      const n = (Number(m[2]) || 1) * (crit ? 2 : 1);
      let sub = 0;
      for (let i = 0; i < n; i++) sub += d(Number(m[3]));
      total += sign * sub;
      parts.push(`${n}d${m[3]}`);
    } else if (m[4]) total += Number(m[4]);
  }
  return Math.max(0, total);
}
export const avg = (expr, mod = 0) => {
  let t = 0;
  for (const m of String(expr || '0').replace(/MOD/gi, String(mod)).replace(/\s+/g, '').matchAll(/([+-]?)(\d*)d(\d+)|([+-]?\d+)/g)) {
    if (m[3]) t += (m[1] === '-' ? -1 : 1) * (Number(m[2]) || 1) * (Number(m[3]) + 1) / 2;
    else if (m[4]) t += Number(m[4]);
  }
  return t;
};
export const mod = (score) => Math.floor(((Number(score) || 10) - 10) / 2);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
