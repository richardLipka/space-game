import type { TuningConfig } from "./config";
import { meanLoss, paramsOf, type GaState } from "./ga";
import { currentValue, toUnit } from "./genome";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A self-contained HTML page for a GA run: loss over generations, the best parameters, fight lengths. */
export function gaReport(s: GaState, cfg: TuningConfig): string {
  const h = s.history;
  const W = 640;
  const H = 200;
  const maxL = Math.max(0.01, ...h.map((x) => Math.min(x.median, (h[0]?.median ?? 1) * 1.5)));
  const x = (i: number) => (h.length > 1 ? (i / (h.length - 1)) * W : W / 2);
  const y = (v: number) => H - (Math.min(v, maxL) / maxL) * H;
  const line = (f: (g: (typeof h)[number]) => number) =>
    h.map((g, i) => `${x(i).toFixed(1)},${y(f(g)).toFixed(1)}`).join(" ");
  let runBest = Infinity;
  const bestLine = line((g) => (runBest = Math.min(runBest, g.best)));
  const best = s.best;
  const bp = best ? paramsOf(s, best) : null;
  const geneRows = s.genes
    .map((g) => {
      const v = bp?.[g.id] ?? currentValue(g);
      const u = toUnit(g, v);
      const c = toUnit(g, currentValue(g));
      return `<tr><td>${esc(g.id)}</td><td class="l">${esc(g.note ?? g.target)}</td><td>${currentValue(g)}</td><td><b>${v}</b></td>
<td class="bar"><svg width="160" height="12"><rect x="0" y="5" width="160" height="2" class="track"/><rect x="${(c * 160 - 1).toFixed(1)}" y="1" width="2" height="10" class="now"/><circle cx="${(u * 160).toFixed(1)}" cy="6" r="4" class="val"/></svg></td><td>${g.min}–${g.max}</td></tr>`;
    })
    .join("");
  const matchRows = cfg.matchups
    .map((m) => {
      const med = best?.last?.medians[m.id];
      const to = best?.last?.timeouts[m.id] ?? 0;
      const ok = med !== undefined && med >= m.band[0] && med <= m.band[1];
      return `<tr><td>${esc(m.id)}</td><td class="l">${esc(m.sides[0].join(", "))}</td><td>${m.band[0]}–${m.band[1]} s</td><td class="${ok ? "ok" : "bad"}">${med ?? "–"} s</td><td>${Math.round(to * 100)} %</td></tr>`;
    })
    .join("");
  const pop = [...s.population]
    .filter((i) => i.evals > 0)
    .sort((a, b) => meanLoss(a) - meanLoss(b))
    .slice(0, 12)
    .map(
      (i) =>
        `<tr><td>#${i.id}</td><td class="l">${esc(i.origin)}</td><td>${i.evals}</td><td>${meanLoss(i).toFixed(3)}</td><td>${i.last?.inBand ?? "–"}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tuning run</title>
<style>
:root{--bg:#fff;--fg:#111;--muted:#666;--line:#ddd;--a:#2563eb;--b:#9ca3af;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--line:#333;--a:#60a5fa;--b:#555;--ok:#4ade80;--bad:#f87171}}
body{font:14px system-ui;margin:24px auto;max-width:900px;padding:0 16px;background:var(--bg);color:var(--fg)}
table{border-collapse:collapse;margin:8px 0 20px;width:100%;display:block;overflow-x:auto}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:right}
.l{text-align:left}th{color:var(--muted);font-weight:500}.ok{color:var(--ok)}.bad{color:var(--bad)}
.track{fill:var(--line)}.now{fill:var(--muted)}.val{fill:var(--a)}svg.chart{width:100%;height:auto;overflow:visible}
.muted{color:var(--muted)}</style>
<h1>Tuning run</h1>
<p class="muted">Generation ${s.generation}, ${(s.elapsed / 3600).toFixed(2)} h, ${h.reduce((a, g) => a + g.battles, 0)} battles. Population ${s.options.population}, ${s.options.seeds} seeds per matchup.
${best ? `Best: #${best.id}, loss ${meanLoss(best).toFixed(3)} over ${best.evals} measurements, ${best.last?.inBand}/${cfg.matchups.length} matchups in band.` : ""}</p>
<h2>Loss by generation</h2>
<svg class="chart" viewBox="-4 -4 ${W + 8} ${H + 8}"><polyline fill="none" stroke="var(--b)" stroke-width="1.5" points="${line((g) => g.median)}"/><polyline fill="none" stroke="var(--a)" stroke-width="2" points="${bestLine}"/></svg>
<p class="muted">Blue: best so far. Grey: population median.</p>
<h2>Fight lengths of the best</h2>
<table><tr><th class="l">matchup</th><th class="l">ships per side</th><th>band</th><th>median</th><th>timeouts</th></tr>${matchRows}</table>
<h2>Parameters of the best</h2>
<table><tr><th class="l">gene</th><th class="l">meaning</th><th>now</th><th>best</th><th>range (tick: now)</th><th>limits</th></tr>${geneRows}</table>
<h2>Population</h2>
<table><tr><th>id</th><th class="l">origin</th><th>measured</th><th>mean loss</th><th>in band</th></tr>${pop}</table>
</html>`;
}
