import { Run, toHero } from '../src/game.js';
import { localCharacter } from '../src/notetiger.js';
const res = {}; let floorsSum = 0;
const N = Number(process.argv[2] || 200), lvl = Number(process.argv[3] || 3), size = Number(process.argv[4] || 4);
for (let i = 0; i < N; i++) {
  const heroes = ['Fighter','Rogue','Cleric','Wizard'].slice(0,size).map((c) => toHero(localCharacter({ level: lvl, cls: c })));
  const run = new Run({ id: 't'+i, heroes, auto: true, level: lvl, edition: i%2?'2014':'2024' });
  let steps = 0;
  while (run.state !== 'ended' && steps++ < 500) { if (!run.exploreStep()) break; }
  if (run.state !== 'ended') { console.log('STUCK', run.state, steps, run.floorN, run.here, run.waiting, run.log.slice(-4)); run.end('stuck', 'stuck'); }
  res[run.result] = (res[run.result]||0)+1; floorsSum += run.floorN;
  if (i===0) console.log(run.events.slice(0,25).join('\n'), '\n...', run.events.slice(-5).join('\n'));
}
console.log(res, 'avg floor', (floorsSum/N).toFixed(2));
