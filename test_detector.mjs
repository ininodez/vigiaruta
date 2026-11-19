// Simulated-timeline tests for detector.js:  node test_detector.mjs
import { Detector } from './detector.js';

const FPS = 30, DT = 1000 / FPS;
const OPEN = { blink: 0.05, jaw: 0.05, ear: 0.30, mar: 0.05, pitch: 2, roll: 0, noseY: 0.55 };
const CLOSED = { blink: 0.85, ear: 0.08 };
const SQUINT = { blink: 0.75, ear: 0.12 };
let failures = 0;

function run(name, script, check) {
  const d = new Detector(); let t = 0; const events = [];
  d.reset(0); d.startCalibration(0);
  const step = (f, ms) => { for (let e = 0; e < ms; e += DT) { t += DT; for (const ev of d.update(f, t)) events.push({ t: +(t / 1000).toFixed(2), ...ev }); } };
  step(OPEN, 4500);                                   // calibration
  script(step, (ms) => {                              // "normal driving" with a 150 ms blink every 4 s
    for (let e = 0; e < ms; e += 4000) { step(OPEN, 3850); step({ ...OPEN, ...CLOSED }, 150); }
  });
  const by = type => events.filter(e => e.type === type);
  const res = check(by, d.stats(t), events);
  const ok = res === true;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + res}`);
  if (!ok || process.env.V) console.log('      ', events.filter(e => e.type !== 'calibrated').map(e => `${e.t}s ${e.type}${e.count ? '#' + e.count : ''}${e.reason ? ' (' + e.reason + ')' : ''}`).join(' | '));
}
const expect = (cond, msg) => cond ? true : msg;

run('Conducción normal 2 min: sin falsas alarmas', (s, drive) => drive(120000),
  by => expect(!by('microsleep').length && !by('yawn').length && !by('nod').length && !by('alarm').length && !by('stop').length, 'hubo eventos'));

run('3 bostezos (con ojos entrecerrados) -> 3 bostezos, 0 microsueños, pide parar en el 3.º', (s, drive) => {
  for (let i = 0; i < 3; i++) { drive(20000); s({ ...OPEN, jaw: 0.8, mar: 0.9 }, 1000); s({ ...OPEN, ...SQUINT, jaw: 0.85, mar: 0.9 }, 2000); s(OPEN, 500); }
  drive(8000);
}, by => expect(by('yawn').length === 3 && !by('microsleep').length && !by('alarm').length &&
  by('stop').length === 1 && by('stop')[0].reason.startsWith('3 bostezos'), 'conteo/parada incorrectos'));

run('Bostezo con la boca a medio cerrar un instante (tolerancia 0,35 s) cuenta 1', (s, drive) => {
  drive(8000); s({ ...OPEN, jaw: 0.7 }, 700); s({ ...OPEN, jaw: 0.3 }, 250); s({ ...OPEN, jaw: 0.7 }, 900); drive(4000);
}, by => expect(by('yawn').length === 1, `bostezos=${by('yawn').length}`));

run('Hablar (boca abierta < 1,2 s) no es bostezo', (s, drive) => {
  for (let i = 0; i < 10; i++) { s({ ...OPEN, jaw: 0.6 }, 600); s(OPEN, 400); } drive(4000);
}, by => expect(!by('yawn').length, 'contó bostezo'));

run('2 microsueños de 1,3 s -> 2 microsueños, pide parar, sin sirena', (s, drive) => {
  drive(10000); s({ ...OPEN, ...CLOSED }, 1300); drive(10000); s({ ...OPEN, ...CLOSED }, 1300); drive(4000);
}, by => expect(by('microsleep').length === 2 && !by('alarm').length && by('stop').some(e => e.reason.startsWith('2 microsueños')), 'microsueños incorrectos'));

run('Ojos cerrados 2,4 s -> sirena a los 2 s y se apaga al abrir', (s, drive) => {
  drive(8000); s({ ...OPEN, ...CLOSED }, 2400); drive(6000);
}, (by) => expect(by('alarm').length === 1 && by('alarm_end').length === 1 && Math.abs(by('alarm')[0].t - 14.5) < 0.15, `alarma en ${by('alarm')[0]?.t}`));

run('Cabeceo de 0,6 s (cabeza cae 20°) se cuenta; 2 cabeceos piden parar', (s, drive) => {
  drive(8000); s({ ...OPEN, pitch: 22 }, 600); drive(10000); s({ ...OPEN, pitch: 24 }, 700); drive(4000);
}, by => expect(by('nod').length === 2 && by('stop').some(e => e.reason.startsWith('2 cabeceos')), `cabeceos=${by('nod').length}`));

run('Cabeceo rápido con ojos cerrados (0,5 s) se cuenta', (s, drive) => {
  drive(8000); s({ ...OPEN, ...CLOSED, pitch: 18 }, 550); drive(4000);
}, by => expect(by('nod').length === 1 && !by('microsleep').length, `cabeceos=${by('nod').length}`));

run('Mirar el tablero 0,3 s (cabeza baja 16°) NO es cabeceo', (s, drive) => {
  for (let i = 0; i < 5; i++) { drive(4000); s({ ...OPEN, pitch: 18 }, 300); } drive(2000);
}, by => expect(!by('nod').length, 'contó cabeceo'));

run('Cabeza cae y sale de cuadro -> cabeceo', (s, drive) => {
  drive(8000); s({ ...OPEN, pitch: 11 }, 200); s(null, 1500); drive(4000);
}, by => expect(by('nod').length === 1, `cabeceos=${by('nod').length}`));

run('Cabeza cae hacia el lado 0,6 s -> cabeceo', (s, drive) => {
  drive(8000); s({ ...OPEN, roll: 28 }, 600); drive(4000);
}, by => expect(by('nod').length === 1 && by('nod')[0].kind.includes('lado'), 'no detectó'));

run('Cabeza caída + ojos cerrados prolongado -> sirena', (s, drive) => {
  drive(8000); s({ ...OPEN, ...CLOSED, pitch: 25 }, 800); s(null, 3500); drive(5000);
}, by => expect(by('alarm').length >= 1, 'sin alarma'));

run('Ojos cerrados y luego se pierde el rostro -> microsueño y sirena igual', (s, drive) => {
  drive(8000); s({ ...OPEN, ...CLOSED }, 500); s(null, 3500); drive(5000);
}, by => expect(by('microsleep').length === 1 && by('alarm').length === 1, 'falló'));

run('Rostro se pierde sin bajar la cabeza (giro a espejo) NO es cabeceo', (s, drive) => {
  drive(8000); s(null, 1500); drive(4000);
}, by => expect(!by('nod').length, 'contó cabeceo'));

console.log(failures ? `\n${failures} prueba(s) fallaron` : '\nTodas las pruebas pasaron');
process.exit(failures ? 1 : 0);
