'use strict';
/* =====================================================================
   Automatische Inseratsuche (läuft per GitHub Actions)

   Der Workflow startet alle 30 Minuten. Dieses Skript entscheidet dann (Zeitplan), ob wirklich
   geprüft wird: immer bei manuellem Start ("Jetzt prüfen" in der App), sonst nur wenn die
   automatische Prüfung in der App eingeschaltet und das Intervall erreicht ist.

   Ablauf je Suchprofil:
     Trefferliste laden -> neue Inserate erkennen -> Inserat laden -> Felder auslesen
     (InseratParser) -> Score berechnen (Bewertung) -> in data/funde.json speichern
     -> bei Treffern der Kriterien und hohem Score Push aufs Handy (ntfy.sh).

   Grenzen (bewusst): wenige Abrufe, Pause zwischen den Abrufen, ehrlicher User-Agent.
   Bei Sperre (HTTP 403/429/503 oder Captcha) bricht der Lauf ab und meldet das.
   Es wird nichts umgangen.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const L = require('../logik.js');

const EXPOSE_URL = 'https://www.immobilienscout24.de/expose/';
const PAUSE_MS = [3500, 6500];          // zufällige Pause zwischen zwei Abrufen
const MAX_NEU_PRO_LAUF = 10;            // so viele neue Inserate werden pro Lauf höchstens geladen
const MAX_PUSH_PRO_LAUF = 3;            // so viele einzelne Push-Nachrichten pro Lauf
const MAX_FUNDE = 150;                  // so viele bewertete Inserate bleiben gespeichert
const TOLERANZ_MIN = 5;                 // Toleranz beim Intervall (GitHub startet Läufe nicht auf die Minute)
const warte = ms => new Promise(r => setTimeout(r, ms));

/** Die Seite verweigert den Abruf (Sperre, Ratenbegrenzung, Captcha). */
class Blockiert extends Error {}

/* ---------------------------------------------------------------------
   Einstellungen (config/einstellungen.json, wird in der App bearbeitet)
   --------------------------------------------------------------------- */
class Konfig {
  // Liest die Einstellungen; nur aktive Profile bleiben übrig
  static lade(datei) {
    let roh;
    try { roh = JSON.parse(fs.readFileSync(datei, 'utf8')); }
    catch (e) { throw new Error('config/einstellungen.json nicht lesbar: ' + e.message); }
    const e = L.Einstellungen.normalisiere(roh);
    e.profile = e.profile.filter(p => p.aktiv === true).map(Konfig.pruefe);
    return e;
  }
  static pruefe(p) {
    const fehler = L.Einstellungen.pruefeProfil(p);
    if (fehler) throw new Error(fehler);
    return p;
  }
}

/* ---------------------------------------------------------------------
   Zeitplan: soll jetzt geprüft werden?
   --------------------------------------------------------------------- */
class Zeitplan {
  static entscheide(auto, letzterLauf, ereignis, jetzt = Date.now()) {
    if (ereignis === 'workflow_dispatch') return {lauf:true, grund:'manuell gestartet'};
    if (!auto.aktiv) return {lauf:false, grund:'automatische Prüfung ist ausgeschaltet'};
    const minuten = letzterLauf ? (jetzt - Date.parse(letzterLauf)) / 60000 : Infinity;
    if (minuten < auto.intervallMinuten - TOLERANZ_MIN)
      return {lauf:false, grund:`letzte Prüfung vor ${Math.round(minuten)} Min., Intervall ${auto.intervallMinuten} Min.`};
    return {lauf:true, grund:'Intervall erreicht'};
  }
}

/* ---------------------------------------------------------------------
   Abruf von Webseiten (mit Pause, Timeout und Sperr-Erkennung)
   --------------------------------------------------------------------- */
class Abrufer {
  constructor() { this.erster = true; }
  async hole(url) {
    if (!this.erster) await warte(PAUSE_MS[0] + Math.random() * (PAUSE_MS[1] - PAUSE_MS[0]));
    this.erster = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res, html;
    try {
      res = await fetch(url, {signal:ctrl.signal, headers:{
        'User-Agent':'ImmoAnalyse-Privat/1.0 (persoenliche Nutzung)',
        'Accept':'text/html', 'Accept-Language':'de-DE,de;q=0.9'}});
      html = await res.text();
    } finally { clearTimeout(timer); }
    if ([403, 429, 503].includes(res.status)) throw new Blockiert('HTTP ' + res.status);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return html;
  }
}

/* ---------------------------------------------------------------------
   HTML -> Text (damit der InseratParser den Seitentext wie kopierten Text lesen kann)
   --------------------------------------------------------------------- */
class HtmlText {
  static zuText(html) {
    const ent = {nbsp:' ', amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", euro:'€', auml:'ä', ouml:'ö', uuml:'ü',
                 Auml:'Ä', Ouml:'Ö', Uuml:'Ü', szlig:'ß', sup2:'²', middot:'·'};
    return String(html)
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(?:div|p|li|tr|td|th|h[1-6]|dd|dt|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&([a-zA-Z0-9]+);/g, (m, n) => ent[n] ?? m)
      .replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
  }
  // Überschrift des Inserats (h1, sonst title)
  static titel(html) {
    const m = String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? HtmlText.zuText(m[1]).replace(/\s+/g, ' ').trim() : '';
  }
}

/* ---------------------------------------------------------------------
   Trefferliste: Inserat-IDs erkennen, Sperrseiten erkennen
   --------------------------------------------------------------------- */
class Trefferliste {
  static exposeIds(html) {
    const ids = [];
    for (const m of String(html).matchAll(/\/expose\/(\d{6,12})/g)) if (!ids.includes(m[1])) ids.push(m[1]);
    return ids;
  }
  static istSperre(html) { return /captcha|geetest|kein Roboter/i.test(html); }
}

/* ---------------------------------------------------------------------
   Archiv: data/funde.json (für die App) und data/gesehen.json (bereits geprüfte IDs)
   --------------------------------------------------------------------- */
class Archiv {
  constructor(ordner) {
    this.ordner = ordner;
    this.fundeDatei = path.join(ordner, 'funde.json');
    this.gesehenDatei = path.join(ordner, 'gesehen.json');
    this.funde = this.lies(this.fundeDatei, {aktualisiert:null, status:'ok', meldung:'', funde:[]});
    this.gesehen = new Set(this.lies(this.gesehenDatei, {ids:[]}).ids);
  }
  lies(datei, standard) { try { return JSON.parse(fs.readFileSync(datei, 'utf8')); } catch (e) { return standard; } }
  istBekannt(id) { return this.gesehen.has(id); }
  merke(id) { this.gesehen.add(id); }
  fuegeFundHinzu(fund) { this.funde.funde.unshift(fund); this.funde.funde = this.funde.funde.slice(0, MAX_FUNDE); }
  setzeStatus(status, meldung) { this.funde.status = status; this.funde.meldung = meldung; }
  markiereLauf() { this.funde.aktualisiert = new Date().toISOString(); }     // Zeitpunkt des letzten echten Laufs
  // Rohdaten einer nicht lesbaren Seite zur Fehlersuche ablegen
  notiereDebug(html) {
    fs.mkdirSync(this.ordner, {recursive:true});
    fs.writeFileSync(path.join(this.ordner, 'debug-suche.txt'), String(html).slice(0, 3000));
  }
  speichere() {
    fs.mkdirSync(this.ordner, {recursive:true});
    fs.writeFileSync(this.fundeDatei, JSON.stringify(this.funde));
    fs.writeFileSync(this.gesehenDatei, JSON.stringify({ids:[...this.gesehen].slice(-3000)}));
  }
}

/* ---------------------------------------------------------------------
   Bewertung eines Inserats mit den Annahmen des Suchprofils
   --------------------------------------------------------------------- */
class Bewerter {
  constructor(profil) { this.p = profil; }

  bewerte(text, url) {
    const r = L.InseratParser.alsImmobilie(text, {url, bundesland:this.p.bundesland, mieteQm:this.p.mieteQm, marktQm:this.p.marktQm});
    this.setzeFinanzierung(r.objekt);
    return {objekt:r.objekt, analyse:L.Bewertung.analyse(r.objekt), erkannt:r.erkannt.length, fehlend:r.fehlend};
  }
  // Standard-Finanzierung: Eigenkapital = Nebenkosten + x % des Kaufpreises, Tilgung 2 %
  setzeFinanzierung(o) {
    const f = o.finanz, p = this.p;
    f.kaufpreisLink = true; f.kaufpreis = o.kaufpreis; f.modus = 'tilgung'; f.tilgung = 2;
    f.zins1 = p.zins; f.zins2 = p.zins + 0.7;
    f.eigenkapital = Math.round(L.Rechner.nebenkosten(o).summe + o.kaufpreis * p.ekProzent / 100);
  }
}

/* ---------------------------------------------------------------------
   Push-Nachricht aufs Handy über ntfy.sh (Topic = geheimer Name aus GitHub Secret)
   --------------------------------------------------------------------- */
class Push {
  constructor(topic, appUrl) { this.topic = topic; this.appUrl = appUrl; }
  async sende(titel, text, {link, prio = 3, tags = []} = {}) {
    if (!this.topic) return;
    const body = {topic:this.topic, title:titel, message:text, priority:prio, tags};
    if (link) body.click = link;
    if (this.appUrl) body.actions = [{action:'view', label:'In der App', url:this.appUrl}];
    try { await fetch('https://ntfy.sh/', {method:'POST', body:JSON.stringify(body)}); }
    catch (e) { console.log('Push fehlgeschlagen:', e.message); }
  }
}

/* ---------------------------------------------------------------------
   Suchlauf: steuert alle Profile
   Es werden alle lesbaren Inserate gespeichert. Welche in der App erscheinen, entscheiden
   die Kriterien (so wirken geänderte Kriterien sofort, auch auf frühere Funde).
   --------------------------------------------------------------------- */
class Suchlauf {
  constructor({konfig, archiv, abrufer, push}) {
    Object.assign(this, {konfig, archiv, abrufer, push});
    this.gute = []; this.warnungen = [];
    this.geprueft = 0; this.gespeichert = 0; this.ungelesen = 0;
  }

  async starte() {
    const vorher = this.archiv.funde.status;
    let status = 'ok', meldung = '';
    try {
      if (!this.konfig.profile.length) this.warnungen.push('Kein aktives Suchprofil (unter „Suche“ ein Profil aktivieren)');
      for (const profil of this.konfig.profile) await this.profil(profil);
      if (this.geprueft >= 3 && this.ungelesen > this.geprueft / 2)
        this.warnungen.push('Die meisten Inserate konnten nicht gelesen werden (Seitenaufbau geändert?)');
      if (this.warnungen.length) { status = 'warnung'; meldung = this.warnungen.join(' | '); }
    } catch (e) {
      if (e instanceof Blockiert) {
        status = 'blockiert';
        meldung = `ImmoScout24 verweigert den Abruf (${e.message}). Der Lauf wurde gestoppt, es wird nichts umgangen.`;
      } else { status = 'fehler'; meldung = 'Fehler: ' + e.message; }
    }
    this.archiv.setzeStatus(status, meldung);
    this.archiv.markiereLauf();
    this.archiv.speichere();
    await this.benachrichtige(status, meldung, vorher);
    console.log(`Status ${status} | geprüft ${this.geprueft} | gespeichert ${this.gespeichert} | ungelesen ${this.ungelesen} ${meldung}`);
    return status;
  }

  // Ein Suchprofil: Trefferliste laden, neue Inserate nacheinander prüfen
  async profil(p) {
    const html = await this.abrufer.hole(p.url);
    const ids = Trefferliste.exposeIds(html);
    if (!ids.length) {
      if (Trefferliste.istSperre(html)) throw new Blockiert('Captcha-Abfrage');
      this.warnungen.push(`„${p.name}“: keine Inserate erkannt (Seitenaufbau geändert oder keine Treffer)`);
      this.archiv.notiereDebug(html);
      return;
    }
    const bewerter = new Bewerter(p);
    for (const id of ids.filter(i => !this.archiv.istBekannt(i))) {
      if (this.geprueft >= MAX_NEU_PRO_LAUF) break;                 // Rest folgt im nächsten Lauf
      await this.inserat(id, p, bewerter);
    }
  }

  // Ein Inserat laden, auslesen, bewerten und speichern
  async inserat(id, p, bewerter) {
    const url = EXPOSE_URL + id;
    let seite;
    try { seite = await this.abrufer.hole(url); }
    catch (e) {
      if (e instanceof Blockiert) throw e;
      this.archiv.merke(id); console.log('Übersprungen', id, e.message); return;   // z. B. Inserat gelöscht
    }
    this.geprueft++; this.archiv.merke(id);
    const r = bewerter.bewerte(HtmlText.titel(seite) + '\n' + HtmlText.zuText(seite), url);
    if (r.erkannt < 3 || !r.analyse.score) { this.ungelesen++; return; }
    const score = r.analyse.score;
    // gefunden = Zeitpunkt der ersten Erkennung (die App zeigt daraus "erkannt vor ...")
    this.archiv.fuegeFundHinzu({id, profil:p.name, gefunden:r.objekt.erkanntAm, score:score.wert, urteil:score.urteil, objekt:r.objekt});
    this.gespeichert++;
    const kr = this.konfig.kriterien;
    if (L.Kriterien.passt(r.objekt, r.analyse, kr).passt && score.wert >= (kr.pushScore || 0)) {
      this.gute.push({score:score.wert, name:r.objekt.name, link:url,
        text:`${r.objekt.ort || ''} · ${L.Fmt.eur(r.objekt.kaufpreis)} · ${r.objekt.wohnflaeche} m² · Brutto ${L.Fmt.pct(r.analyse.k.bruttoRendite)}`});
    }
  }

  async benachrichtige(status, meldung, vorher) {
    for (const g of this.gute.slice(0, MAX_PUSH_PRO_LAUF)) await this.push.sende(`Score ${g.score}: ${g.name}`, g.text, {link:g.link, prio:4, tags:['house']});
    if (this.gute.length > MAX_PUSH_PRO_LAUF) await this.push.sende('Weitere gute Funde', `${this.gute.length - MAX_PUSH_PRO_LAUF} weitere Inserate mit gutem Score, siehe App.`);
    if (status !== 'ok' && status !== vorher) await this.push.sende('Immo-Suche: ' + status, meldung, {prio:4, tags:['warning']});
  }
}

/* ---------------------------------------------------------------------
   Start
   --------------------------------------------------------------------- */
async function main() {
  const wurzel = path.join(__dirname, '..');
  const archiv = new Archiv(path.join(wurzel, 'data'));
  let konfig;
  try { konfig = Konfig.lade(path.join(wurzel, 'config', 'einstellungen.json')); }
  catch (e) {                                           // fehlerhafte Einstellungen: Fehler in der App sichtbar machen
    console.error(e.message);
    if (archiv.funde.status !== 'fehler' || archiv.funde.meldung !== e.message) { archiv.setzeStatus('fehler', e.message); archiv.speichere(); }
    return;
  }
  const plan = Zeitplan.entscheide(konfig.auto, archiv.funde.aktualisiert, process.env.GITHUB_EVENT_NAME);
  console.log('Zeitplan:', plan.grund);
  if (!plan.lauf) return;
  await new Suchlauf({konfig, archiv, abrufer:new Abrufer(), push:new Push(process.env.NTFY_TOPIC, process.env.APP_URL)}).starte();
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = {Konfig, Zeitplan, Abrufer, HtmlText, Trefferliste, Archiv, Bewerter, Push, Suchlauf, Blockiert};
