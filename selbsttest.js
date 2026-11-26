'use strict';
/* =====================================================================
   Selbsttest des Suchjobs ohne Netzwerk: simulierte Seiten, Archiv in Temp-Ordner.
   Start: node scripts/selbsttest.js
   ===================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../logik.js');
const {Konfig, Zeitplan, HtmlText, Trefferliste, Archiv, Suchlauf, Blockiert} = require('./suche.js');

// ---- Simulierte Seiten ----
const SUCHE = 'https://www.immobilienscout24.de/Suche/de/nordrhein-westfalen/koeln/wohnung-kaufen?sorting=2';
const U = id => 'https://www.immobilienscout24.de/expose/' + id;
const trefferliste = `<html><body><a href="/expose/111111111">A</a><a href="/expose/222222222">B</a>
  <a href="/expose/111111111">A nochmal</a><a href="/expose/333333333">C</a></body></html>`;
const expose = (titel, ort, daten) => `<html><head><title>x | ImmoScout24</title><script>var kaufpreis="Kaufpreis 1 €";</script></head><body>
  <nav>Menü</nav><h1 id="expose-title">${titel}</h1><div><span>${ort}</span></div>
  <dl>${daten.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></body></html>`;

const gut = expose('3-Zimmer-Wohnung mit Balkon &amp; Stellplatz', '50667 K&ouml;ln, Altstadt-Nord', [
  ['Kaufpreis', '229.000&nbsp;&euro;'], ['Wohnfl&auml;che ca.', '78,5 m&sup2;'], ['Zimmer', '3'], ['Baujahr', '2004'],
  ['Energieeffizienzklasse', 'B'], ['Endenergiebedarf', '62,0 kWh/(m&sup2;*a)'], ['Befeuerungsart', 'Fernw&auml;rme'],
  ['Hausgeld', '260 &euro;'], ['K&auml;uferprovision', '3,57 % (inkl. MwSt.)'], ['Objektzustand', 'gepflegt']]);
const schlecht = expose('1-Zimmer-Apartment, sanierungsbedürftig', '50667 Köln, Zentrum', [
  ['Kaufpreis', '590.000 €'], ['Wohnfläche', '38 m²'], ['Zimmer', '1'], ['Baujahr', '1965'],
  ['Energieeffizienzklasse', 'H'], ['Heizungsart', 'Öl'], ['Hausgeld', '420 €']]);

class FakeAbrufer {
  constructor(seiten) { this.seiten = seiten; this.aufrufe = []; }
  async hole(url) {
    this.aufrufe.push(url);
    const s = this.seiten[url];
    if (s instanceof Error) throw s;
    if (s === undefined) throw new Error('HTTP 404');
    return s;
  }
}
class FakePush { constructor() { this.nachrichten = []; } async sende(titel, text) { this.nachrichten.push({titel, text}); } }

const profil = Konfig.pruefe(Object.assign(L.Einstellungen.standardProfil(), {name:'Test Köln', aktiv:true, url:SUCHE, mieteQm:12.5, marktQm:3600}));
const kriterien = Object.assign(L.Einstellungen.standard().kriterien, {minScore:40, pushScore:55});
const konfig = {auto:{aktiv:true, intervallMinuten:60}, kriterien, profile:[profil]};
const neuesArchiv = () => new Archiv(fs.mkdtempSync(path.join(os.tmpdir(), 'immo-test-')));
const bewertet = f => { const o = L.Immobilie.normalisiere(JSON.parse(JSON.stringify(f.objekt))); return {o, a:L.Bewertung.analyse(o)}; };

(async () => {
  // 1) Hilfsfunktionen
  const t = HtmlText.zuText('<div>Kaufpreis</div><div>1.234&nbsp;&euro;</div><script>x=1</script>K&ouml;ln &#228; &#xE4;');
  assert.ok(/Kaufpreis\n1\.234 €\nKöln ä ä/.test(t), 'HTML-Text: ' + JSON.stringify(t));
  assert.deepStrictEqual(Trefferliste.exposeIds(trefferliste), ['111111111', '222222222', '333333333']);
  assert.throws(() => Konfig.pruefe({name:'x', url:'http://evil.example/', mieteQm:10}));
  assert.throws(() => Konfig.pruefe({name:'x', url:SUCHE}));
  assert.strictEqual(L.Fmt.vor(new Date(Date.now() - 3 * 3600e3).toISOString()), 'vor 3 Std.');
  assert.strictEqual(L.Fmt.vor(new Date(Date.now() - 3 * 86400e3).toISOString()), 'vor 3 Tagen');

  // 2) Zeitplan
  const jetzt = Date.parse('2026-11-26T12:00:00Z'), vor = min => new Date(jetzt - min * 60000).toISOString();
  assert.ok(Zeitplan.entscheide({aktiv:false, intervallMinuten:60}, vor(1), 'workflow_dispatch', jetzt).lauf, 'manuell läuft immer');
  assert.ok(!Zeitplan.entscheide({aktiv:false, intervallMinuten:60}, vor(999), 'schedule', jetzt).lauf, 'aus -> kein Lauf');
  assert.ok(!Zeitplan.entscheide({aktiv:true, intervallMinuten:60}, vor(10), 'schedule', jetzt).lauf, 'Intervall nicht erreicht');
  assert.ok(Zeitplan.entscheide({aktiv:true, intervallMinuten:60}, vor(57), 'schedule', jetzt).lauf, 'Toleranz');
  assert.ok(Zeitplan.entscheide({aktiv:true, intervallMinuten:60}, null, 'schedule', jetzt).lauf, 'erster Lauf');

  // 3) Normaler Lauf: beide lesbaren Inserate werden gespeichert, 404 übersprungen
  let archiv = neuesArchiv(), push = new FakePush();
  assert.strictEqual(archiv.funde.aktualisiert, null);
  let abruf = new FakeAbrufer({[SUCHE]:trefferliste, [U('111111111')]:gut, [U('222222222')]:schlecht});
  let status = await new Suchlauf({konfig, archiv, abrufer:abruf, push}).starte();
  assert.strictEqual(status, 'ok');
  assert.ok(archiv.funde.aktualisiert, 'Zeitpunkt des Laufs gesetzt');
  assert.strictEqual(archiv.funde.funde.length, 2, 'alle lesbaren Inserate gespeichert');
  const fG = archiv.funde.funde.find(f => f.id === '111111111'), fS = archiv.funde.funde.find(f => f.id === '222222222');
  console.log('Scores: gut', fG.score, '| schlecht', fS.score);
  assert.strictEqual(fG.objekt.kaufpreis, 229000);
  assert.strictEqual(fG.objekt.name, '3-Zimmer-Wohnung mit Balkon & Stellplatz');
  assert.ok(fG.gefunden && fG.gefunden === fG.objekt.erkanntAm, 'Erstzeitpunkt gespeichert');
  assert.ok(['111111111', '222222222', '333333333'].every(i => archiv.istBekannt(i)));
  assert.strictEqual(push.nachrichten.length, 1, 'nur der gute Fund löst Push aus');

  // 4) Kriterien wirken sofort auf gespeicherte Funde
  const g = bewertet(fG), s = bewertet(fS);
  assert.ok(L.Kriterien.passt(g.o, g.a, kriterien).passt, 'guter Fund passt');
  assert.ok(!L.Kriterien.passt(s.o, s.a, kriterien).passt, 'schlechter Fund passt nicht');
  const mit = extra => L.Kriterien.passt(g.o, g.a, Object.assign({}, kriterien, extra));
  assert.strictEqual(mit({maxPreis:200000}).grund, 'Kaufpreis zu hoch');
  assert.strictEqual(mit({minFlaeche:80}).grund, 'Wohnfläche zu klein');
  assert.strictEqual(mit({maxFlaeche:70}).grund, 'Wohnfläche zu groß');
  assert.strictEqual(mit({minZimmer:4}).grund, 'zu wenige Zimmer');
  assert.strictEqual(mit({minBrutto:9}).grund, 'Bruttomietrendite zu niedrig');
  assert.strictEqual(mit({energieSchlechtestens:'A'}).grund, 'Energieklasse zu schlecht');
  assert.ok(mit({energieSchlechtestens:'C', minZimmer:3, minFlaeche:70, maxPreis:250000}).passt, 'mehrere Kriterien erfüllt');

  // 5) Zweiter Lauf: nichts Neues -> nur die Trefferliste wird geladen
  abruf = new FakeAbrufer({[SUCHE]:trefferliste});
  await new Suchlauf({konfig, archiv:new Archiv(archiv.ordner), abrufer:abruf, push:new FakePush()}).starte();
  assert.deepStrictEqual(abruf.aufrufe, [SUCHE], 'keine erneuten Abrufe');

  // 6) Sperre (HTTP 403): Lauf stoppt, Status und Push
  archiv = neuesArchiv(); push = new FakePush();
  status = await new Suchlauf({konfig, archiv, abrufer:new FakeAbrufer({[SUCHE]:new Blockiert('HTTP 403')}), push}).starte();
  assert.strictEqual(status, 'blockiert'); assert.strictEqual(push.nachrichten.length, 1);

  // 7) Captcha-Seite ohne Treffer -> blockiert
  archiv = neuesArchiv();
  status = await new Suchlauf({konfig, archiv, abrufer:new FakeAbrufer({[SUCHE]:'<html>Bitte Captcha lösen</html>'}), push:new FakePush()}).starte();
  assert.strictEqual(status, 'blockiert');

  // 8) Keine Treffer erkannt (Seitenaufbau geändert) -> Warnung + Debug-Datei
  archiv = neuesArchiv();
  status = await new Suchlauf({konfig, archiv, abrufer:new FakeAbrufer({[SUCHE]:'<html>ganz anderes Layout</html>'}), push:new FakePush()}).starte();
  assert.strictEqual(status, 'warnung'); assert.ok(fs.existsSync(path.join(archiv.ordner, 'debug-suche.txt')));

  // 9) Kein aktives Profil -> Hinweis statt stillem Nichtstun (z. B. bei "Jetzt prüfen")
  archiv = neuesArchiv();
  status = await new Suchlauf({konfig:Object.assign({}, konfig, {profile:[]}), archiv, abrufer:new FakeAbrufer({}), push:new FakePush()}).starte();
  assert.strictEqual(status, 'warnung'); assert.ok(/Kein aktives Suchprofil/.test(archiv.funde.meldung));

  console.log('Alle Selbsttests bestanden.');
})().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
