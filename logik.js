/* =====================================================================
   Rechenlogik und Datenmodell
   Gemeinsam genutzt von index.html (Browser) und scripts/suche.js (Node).
   ===================================================================== */
'use strict';

/* =====================================================================
   KONSTANTEN
   ===================================================================== */
const SPEICHER_KEY = 'immoAnalyse.v1';

// Grunderwerbsteuer je Bundesland (Stand 2026, bitte vor Kauf prüfen) – im Formular überschreibbar
const BUNDESLAENDER = {
  BW:['Baden-Württemberg',5.0], BY:['Bayern',3.5], BE:['Berlin',6.0], BB:['Brandenburg',6.5],
  HB:['Bremen',5.5], HH:['Hamburg',5.5], HE:['Hessen',6.0], MV:['Mecklenburg-Vorpommern',6.0],
  NI:['Niedersachsen',5.0], NW:['Nordrhein-Westfalen',6.5], RP:['Rheinland-Pfalz',5.0], SL:['Saarland',6.5],
  SN:['Sachsen',3.5], ST:['Sachsen-Anhalt',5.0], SH:['Schleswig-Holstein',6.5], TH:['Thüringen',5.0]
};
const ENERGIEKLASSEN = ['A+','A','B','C','D','E','F','G','H'];
// Bewertungswert je Energieklasse (1 = beste, 0 = schlechteste) für den Score
const ENERGIE_WERT = {'A+':1, A:.93, B:.82, C:.7, D:.55, E:.4, F:.25, G:.12, H:0};

const CHECKLISTE = [
  'Energieausweis (Klasse, Gültigkeit) liegt vor',
  'Grundbuchauszug geprüft (Lasten, Wegerechte, Wohnrecht)',
  'Teilungserklärung und Gemeinschaftsordnung gelesen',
  'Protokolle der Eigentümerversammlungen (letzte 3 Jahre) geprüft',
  'Wirtschaftsplan und letzte Hausgeldabrechnung geprüft',
  'Höhe der Instandhaltungsrücklage erfragt',
  'Beschlossene / geplante Sonderumlagen geklärt',
  'Mietvertrag, Mietzahlungen und Kaution geprüft',
  'Vergleichsmiete / Mietspiegel recherchiert',
  'Besichtigung: Dach, Fassade, Keller, Feuchtigkeit',
  'Alter von Heizung, Fenstern, Elektrik, Leitungen geklärt',
  'Anstehende Sanierungen und Kosten eingeschätzt',
  'Baulasten, Altlasten, Erschließung geklärt',
  'Finanzierungsangebote mehrerer Banken eingeholt',
  'Notarvertragsentwurf mind. 14 Tage vor Termin erhalten'
];

/* =====================================================================
   HILFSFUNKTIONEN
   ===================================================================== */
const Fmt = {
  eur: (v, d = 0) => (v == null || isNaN(v)) ? '–' :
       new Intl.NumberFormat('de-DE', {style:'currency', currency:'EUR', minimumFractionDigits:d, maximumFractionDigits:d}).format(v),
  num: (v, d = 1) => (v == null || isNaN(v)) ? '–' :
       new Intl.NumberFormat('de-DE', {minimumFractionDigits:d, maximumFractionDigits:d}).format(v),
  pct: (v, d = 2) => (v == null || isNaN(v)) ? '–' : Fmt.num(v, d) + ' %',
  kurz: v => Math.abs(v) >= 1e6 ? Fmt.num(v / 1e6, 1) + ' Mio' : Math.round(v / 1000) + ' T€',
  // Zeit seit einem Zeitpunkt (ISO-Text), z. B. "vor 3 Std."
  vor: iso => {
    const ms = Date.now() - Date.parse(iso);
    if (!iso || isNaN(ms)) return '–';
    const min = Math.max(0, Math.floor(ms / 60000)), std = Math.floor(min / 60), tage = Math.floor(std / 24);
    if (min < 1) return 'gerade eben';
    if (min < 60) return 'vor ' + min + ' Min.';
    if (std < 24) return 'vor ' + std + ' Std.';
    if (tage < 14) return 'vor ' + tage + (tage === 1 ? ' Tag' : ' Tagen');
    return 'vor ' + Math.floor(tage / 7) + ' Wochen';
  }
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// Ampelfarbe: hoeherBesser=true -> ab "gruen" grün, ab "gelb" gelb, sonst rot
const ampel = (v, gruen, gelb, hoeherBesser = true) => {
  if (v == null) return '';
  if (hoeherBesser) return v >= gruen ? 'good' : v >= gelb ? 'warn' : 'bad';
  return v <= gruen ? 'good' : v <= gelb ? 'warn' : 'bad';
};
const neueId = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(16).slice(2);

/* =====================================================================
   MODELL: Immobilie
   ===================================================================== */
class Immobilie {
  static startStandard() {            // Standard-Starttermin der Finanzierung: nächster Monat
    const d = new Date(); d.setMonth(d.getMonth() + 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  static standardFinanz() {
    return {kaufpreisLink:true, kaufpreis:0, eigenkapital:0, modus:'tilgung', rate:0, tilgung:2,
            zins1:3.8, bindung:10, zins2:4.5, rateNach:null, sonder:0, start:Immobilie.startStandard(), steuersatz:35};
  }
  static standard() {
    return {id:'', name:'Neues Objekt', ort:'', bundesland:'NW', art:'Eigentumswohnung', baujahr:null, wohnflaeche:0,
            zimmer:null, grundstueck:null, etage:'', lageMakro:3, lageMikro:3, zustand:3,
            energieklasse:'D', heizung:'Gas', energiekennwert:null,
            kaufpreis:0, sanierung:0, grest:BUNDESLAENDER.NW[1], notar:1.8, makler:3.57, sonstigeNK:0,
            kaltmiete:0, mietausfall:2, vergleichsmiete:null,
            nichtUml:0, instandhaltung:10, marktpreis:null, wertsteigerung:1.5, gebaeudeanteil:75, afa:2,
            notizen:'', link:'', erkanntAm:null, check:{}, finanz:Immobilie.standardFinanz()};
  }
  // Fehlende Felder mit Standardwerten auffüllen (z. B. nach Import oder App-Update)
  static normalisiere(roh) {
    const s = Immobilie.standard();
    const o = Object.assign(s, roh || {});
    o.finanz = Object.assign(Immobilie.standardFinanz(), (roh && roh.finanz) || {});
    o.check = (roh && roh.check) || {};
    if (!o.id) o.id = neueId();
    return o;
  }
  static neu() { return Immobilie.normalisiere({id:neueId()}); }
  static beispiel() {
    return Immobilie.normalisiere({
      id:neueId(), name:'Beispiel-Wohnung (bitte löschen)', ort:'Musterstadt, Zentrum', bundesland:'NW', baujahr:1998,
      wohnflaeche:65, zimmer:3, lageMakro:3, lageMikro:4, zustand:4, energieklasse:'C', heizung:'Fernwärme',
      kaufpreis:220000, grest:6.5, kaltmiete:780, nichtUml:45, instandhaltung:10, marktpreis:3300, vergleichsmiete:12,
      finanz:{eigenkapital:45000, modus:'rate', rate:950, zins1:3.8, bindung:10, zins2:4.5}
    });
  }
}

/* =====================================================================
   RECHENKERN: Kennzahlen
   ===================================================================== */
class Rechner {
  // Kaufnebenkosten (optional mit abweichendem Kaufpreis)
  static nebenkosten(o, kp = o.kaufpreis) {
    kp = kp || 0;
    const grest = kp * (o.grest || 0) / 100, notar = kp * (o.notar || 0) / 100;
    const makler = kp * (o.makler || 0) / 100, sonst = o.sonstigeNK || 0;
    return {grest, notar, makler, sonst, summe: grest + notar + makler + sonst};
  }
  static kennzahlen(o) {
    const kp = o.kaufpreis || 0, wf = o.wohnflaeche || 0;
    const nk = Rechner.nebenkosten(o);
    const gesamt = kp + nk.summe + (o.sanierung || 0);
    const jkm = (o.kaltmiete || 0) * 12;
    const mietausfall = jkm * (o.mietausfall || 0) / 100;
    const bewirtOhneAusfall = (o.nichtUml || 0) * 12 + (o.instandhaltung || 0) * wf;
    const bewirt = bewirtOhneAusfall + mietausfall;
    const noi = jkm - bewirt;
    const kpQm = wf > 0 ? kp / wf : null, mieteQm = wf > 0 ? (o.kaltmiete || 0) / wf : null;
    return {
      kp, wf, nk, gesamt, jkm, mietausfall, bewirt, bewirtOhneAusfall, noi,
      bruttoRendite: (kp > 0 && jkm > 0) ? jkm / kp * 100 : null,
      nettoRendite:  (gesamt > 0 && jkm > 0) ? noi / gesamt * 100 : null,
      faktor:        jkm > 0 ? kp / jkm : null,
      nettoFaktor:   noi > 0 ? gesamt / noi : null,
      kpQm, gesamtQm: wf > 0 ? gesamt / wf : null, mieteQm,
      vsMarkt:  (o.marktpreis && kpQm) ? (kpQm / o.marktpreis - 1) * 100 : null,
      vsMiete:  (o.vergleichsmiete && mieteQm) ? (mieteQm / o.vergleichsmiete - 1) * 100 : null,
      preisBeiRendite: r => jkm > 0 ? jkm / (r / 100) : null     // Kaufpreis, der eine Ziel-Bruttorendite ergibt
    };
  }
}

/* =====================================================================
   RECHENKERN: Tilgungsplan (monatliche Berechnung)
   Zins/12 pro Monat, Sondertilgung jeweils zum Jahresende.
   ===================================================================== */
class Tilgungsplan {
  constructor(p) { this.p = p; this.berechne(); }
  berechne() {
    const {darlehen, zins1, zins2, bindung, rate1, rate2, sonder = 0, maxMonate = 720} = this.p;
    const bindM = Math.round((bindung || 0) * 12);
    let rest = darlehen, monat = 0, restNachBindung = null;
    let gZins = 0, gTilg = 0, gSonder = 0, jz = 0, jt = 0, js = 0;
    const jahre = [];
    while (rest > 0.005 && monat < maxMonate) {
      monat++;
      const inBindung = monat <= bindM;
      const zinsen = rest * (inBindung ? zins1 : zins2) / 1200;
      let zahlung = inBindung ? rate1 : rate2;
      if (zahlung > rest + zinsen) zahlung = rest + zinsen;      // letzte Rate
      const tilg = zahlung - zinsen;
      rest -= tilg; jz += zinsen; jt += tilg; gZins += zinsen; gTilg += tilg;
      if (monat % 12 === 0 && sonder > 0 && rest > 0.005) {       // Sondertilgung zum Jahresende
        const s = Math.min(sonder, rest); rest -= s; js += s; gSonder += s;
      }
      if (monat === bindM) restNachBindung = rest;
      if (monat % 12 === 0 || rest <= 0.005) {
        jahre.push({jahr: Math.ceil(monat / 12), zinsen: jz, tilgung: jt, sonder: js, rest: Math.max(rest, 0)});
        jz = jt = js = 0;
      }
    }
    this.monate = monat;
    this.getilgt = rest <= 0.005;
    this.gesamtZinsen = gZins; this.gesamtTilgung = gTilg; this.gesamtSonder = gSonder;
    this.restEnde = Math.max(rest, 0);
    this.restNachBindung = restNachBindung === null ? (monat < bindM ? 0 : rest) : restNachBindung;
    this.jahre = jahre;
  }
  // Monat der letzten Rate als Text, z. B. "März 2051"
  datumEnde(startStr) {
    const [y, m] = (startStr || Immobilie.startStandard()).split('-').map(Number);
    return new Date(y, m - 1 + Math.max(this.monate - 1, 0), 1).toLocaleDateString('de-DE', {month:'long', year:'numeric'});
  }
  laufzeitText() {
    if (!this.getilgt) return 'nicht in 60 Jahren';
    const j = Math.floor(this.monate / 12), m = this.monate % 12;
    return j + ' J.' + (m ? ' ' + m + ' M.' : '');
  }
}

/* =====================================================================
   RECHENKERN: Finanzierung und Cashflow
   ===================================================================== */
class Finanzierung {
  // Kaufpreis aus dem Objekt übernehmen, solange die Verknüpfung aktiv ist
  static sync(o) { if (o.finanz.kaufpreisLink) o.finanz.kaufpreis = o.kaufpreis; }

  static berechne(o) {
    const f = o.finanz, kp = f.kaufpreis || 0;
    if (kp <= 0) return null;
    const nk = Rechner.nebenkosten(o, kp);
    const bedarf = kp + nk.summe + (o.sanierung || 0);
    const ek = f.eigenkapital || 0;
    const darlehen = Math.max(0, bedarf - ek);
    const rate1 = f.modus === 'rate' ? (f.rate || 0) : darlehen * ((f.zins1 || 0) + (f.tilgung || 0)) / 1200;
    const rate2 = f.rateNach > 0 ? f.rateNach : rate1;
    const plan = new Tilgungsplan({darlehen, zins1:f.zins1 || 0, zins2:f.zins2 || 0, bindung:f.bindung || 0,
                                   rate1, rate2, sonder:f.sonder || 0});
    const j1 = plan.jahre[0] || {zinsen:0, tilgung:0};
    return {
      kaufpreis:kp, nk, bedarf, ek, darlehen, rate1, rate2, plan,
      ltv: darlehen / kp * 100, ekQuote: bedarf > 0 ? ek / bedarf * 100 : 0,
      tilgungStart: darlehen > 0 ? (rate1 * 12 - darlehen * (f.zins1 || 0) / 100) / darlehen * 100 : 0,
      zinsJ1: j1.zinsen, tilgJ1: j1.tilgung, zahlungJ1: j1.zinsen + j1.tilgung
    };
  }

  // Cashflow vor/nach Steuern (Jahr 1, vereinfacht)
  static cashflow(o, k, fin) {
    if (!fin || k.jkm <= 0) return null;
    const vor = k.noi - fin.zahlungJ1;
    const afa = (fin.kaufpreis + fin.nk.summe) * (o.gebaeudeanteil || 0) / 100 * (o.afa || 0) / 100;
    const ergebnis = k.noi - fin.zinsJ1 - afa;                         // steuerliches Ergebnis aus Vermietung
    const steuerwirkung = -ergebnis * (o.finanz.steuersatz || 0) / 100; // + = Erstattung, - = Steuerzahlung
    return {
      vor, proMonat: vor / 12, nach: vor + steuerwirkung, nachMonat: (vor + steuerwirkung) / 12,
      afa, ergebnis, steuerwirkung, quote: vor / k.jkm * 100,
      ekRendite: fin.ek > 0 ? (vor + fin.tilgJ1) / fin.ek * 100 : null,
      dscr: fin.zahlungJ1 > 0 ? k.noi / fin.zahlungJ1 : null
    };
  }

  // Szenarien: wie wirkt sich ein anderer Anschlusszins aus?
  static szenarien(fin) {
    return [-1, 0, 1, 2, 3].map(d => {
      const zins2 = Math.max(0, fin.plan.p.zins2 + d);
      return {d, zins2, plan: new Tilgungsplan(Object.assign({}, fin.plan.p, {zins2}))};
    });
  }
}

/* =====================================================================
   BEWERTUNG: Score, Hinweise
   ===================================================================== */
class Bewertung {
  static analyse(o) {
    Finanzierung.sync(o);
    const k = Rechner.kennzahlen(o);
    const fin = Finanzierung.berechne(o);
    const cf = Finanzierung.cashflow(o, k, fin);
    const score = Bewertung.score(o, k, (fin && fin.darlehen > 0) ? cf : null);
    return {k, fin, cf, score, hinweise: Bewertung.hinweise(o, k, fin, cf)};
  }

  // Gewichteter Score 0–100 (nur wenn Kaufpreis und Miete vorhanden)
  static score(o, k, cf) {
    if (!(k.kp > 0 && k.jkm > 0)) return null;
    const lin = (x, a, b) => Math.max(0, Math.min(1, (x - a) / (b - a)));
    const teile = [
      {n:'Bruttomietrendite', w:20, v:lin(k.bruttoRendite, 2, 6)},
      {n:'Nettomietrendite',  w:20, v:lin(k.nettoRendite, 1.5, 4)},
      {n:'Kaufpreisfaktor',   w:10, v:lin(k.faktor, 30, 15)},
      {n:'Lage',              w:15, v:((o.lageMakro + o.lageMikro) / 2 - 1) / 4},
      {n:'Zustand',           w:10, v:(o.zustand - 1) / 4},
      {n:'Energieklasse',     w:10, v:ENERGIE_WERT[o.energieklasse] ?? .5}
    ];
    if (cf) teile.push({n:'Cashflow', w:15, v:lin(cf.quote, -30, 10)});
    const wSum = teile.reduce((a, t) => a + t.w, 0);
    const wert = Math.round(teile.reduce((a, t) => a + t.w * t.v, 0) / wSum * 100);
    const urteil = wert >= 70 ? 'Attraktiv' : wert >= 55 ? 'Solide' : wert >= 40 ? 'Genau prüfen' : 'Kritisch';
    return {wert, urteil, teile, cls: wert >= 70 ? 'good' : wert >= 45 ? 'warn' : 'bad'};
  }

  static hinweise(o, k, fin, cf) {
    const h = [], add = (typ, text) => h.push({typ, text});
    if (['F','G','H'].includes(o.energieklasse))
      add('warn', `Energieklasse ${o.energieklasse}: hoher Energiebedarf, Sanierungspflichten (GEG) und Wertabschläge möglich – Sanierungskosten einplanen.`);
    else if (['A+','A','B'].includes(o.energieklasse))
      add('ok', `Energieklasse ${o.energieklasse}: gute Energieeffizienz, geringeres Sanierungsrisiko.`);
    if (o.baujahr && o.baujahr < 1978)
      add('info', 'Baujahr vor 1978 (vor der ersten Wärmeschutzverordnung): Dämmung, Heizung, Leitungen und Elektrik besonders prüfen.');
    if (k.faktor != null) {
      if (k.faktor > 27) add('warn', `Kaufpreisfaktor ${Fmt.num(k.faktor)}: Kaufpreis im Verhältnis zur Miete hoch (günstig: unter 20).`);
      else if (k.faktor <= 20) add('ok', `Kaufpreisfaktor ${Fmt.num(k.faktor)}: günstiges Verhältnis von Kaufpreis zu Miete.`);
    }
    if (k.vsMarkt != null) {
      if (k.vsMarkt > 10) add('warn', `Kaufpreis/m² liegt ${Fmt.num(k.vsMarkt, 0)} % über dem Marktpreis – Verhandlungsspielraum prüfen.`);
      else if (k.vsMarkt < -5) add('ok', `Kaufpreis/m² liegt ${Fmt.num(-k.vsMarkt, 0)} % unter dem Marktpreis.`);
    }
    if (k.vsMiete != null) {
      if (k.vsMiete > 10) add('warn', `Die Miete liegt ${Fmt.num(k.vsMiete, 0)} % über der Vergleichsmiete – Mietpreisbremse/Mietspiegel prüfen, Miete ist ggf. nicht haltbar.`);
      else if (k.vsMiete < -10) add('info', `Die Miete liegt ${Fmt.num(-k.vsMiete, 0)} % unter der Vergleichsmiete – mögliches Mietsteigerungspotenzial (Kappungsgrenzen beachten).`);
    }
    if (k.wf > 0 && k.jkm > 0 && k.bewirtOhneAusfall / k.wf < 15)
      add('info', `Verwaltung + Instandhaltung betragen nur ${Fmt.num(k.bewirtOhneAusfall / k.wf)} €/m²/Jahr – üblich sind etwa 15–35 €/m²/Jahr. Annahme prüfen.`);
    if (fin) {
      if (fin.ltv > 100) add('warn', `Beleihungsauslauf ${Fmt.num(fin.ltv, 0)} %: Vollfinanzierung inkl. Nebenkosten – schlechtere Konditionen, hohes Risiko.`);
      else if (fin.ltv > 90) add('warn', `Beleihungsauslauf ${Fmt.num(fin.ltv, 0)} %: hohe Fremdfinanzierung, Zinsaufschläge wahrscheinlich.`);
      if (fin.darlehen > 0) {
        if (!fin.plan.getilgt) add('warn', 'Mit dieser Rate wird das Darlehen nicht (in 60 Jahren) getilgt – Rate erhöhen.');
        else if (fin.tilgungStart < 2) add('warn', `Anfangstilgung nur ${Fmt.num(fin.tilgungStart)} %: sehr lange Laufzeit und hohe Zinskosten. Üblich sind mindestens 2 %.`);
        if (fin.plan.restNachBindung > fin.darlehen * 0.5)
          add('info', `Nach Ende der Zinsbindung sind noch ${Fmt.num(fin.plan.restNachBindung / fin.darlehen * 100, 0)} % des Darlehens offen – Zinsänderungsrisiko (siehe Szenarien unter Finanzierung).`);
        if (k.nettoRendite != null && k.nettoRendite < fin.plan.p.zins1)
          add('warn', `Nettomietrendite (${Fmt.pct(k.nettoRendite)}) liegt unter dem Darlehenszins (${Fmt.pct(fin.plan.p.zins1)}): Fremdkapital wirkt als negativer Hebel.`);
      }
    }
    if (cf) {
      if (cf.vor < 0) add('warn', `Negativer Cashflow: ca. ${Fmt.eur(-cf.proMonat)} pro Monat Zuzahlung vor Steuern. Reserve einplanen.`);
      else add('ok', `Positiver Cashflow vor Steuern: ca. ${Fmt.eur(cf.proMonat)} pro Monat.`);
      if (cf.dscr != null && cf.dscr < 1) add('warn', 'Schuldendienstdeckung unter 1: Die Nettomiete deckt Zins und Tilgung nicht.');
    }
    add('info', 'Spekulationsfrist: Gewinne aus dem Verkauf innerhalb von 10 Jahren sind in der Regel steuerpflichtig (bei Vermietung).');
    return h;
  }
}

/* =====================================================================
   EINSTELLUNGEN DER AUTOMATISCHEN SUCHE (config/einstellungen.json) UND KRITERIEN
   ===================================================================== */
class Einstellungen {
  static standardProfil() {
    return {name:'Neue Suche', aktiv:false, url:'', bundesland:'NW', mieteQm:12, marktQm:0, ekProzent:20, zins:3.8};
  }
  static standard() {
    return {
      auto:{aktiv:false, intervallMinuten:60},
      kriterien:{minScore:50, pushScore:65, minBrutto:null, maxPreis:null, minFlaeche:null, maxFlaeche:null,
                 minZimmer:null, energieSchlechtestens:''},
      profile:[]};
  }
  // Fehlende Felder mit Standardwerten auffüllen
  static normalisiere(roh) {
    const s = Einstellungen.standard(); roh = roh || {};
    return {auto:Object.assign(s.auto, roh.auto), kriterien:Object.assign(s.kriterien, roh.kriterien),
            profile:(Array.isArray(roh.profile) ? roh.profile : []).map(p => Object.assign(Einstellungen.standardProfil(), p))};
  }
  // Fehlertext zu einem aktiven Profil, '' wenn in Ordnung
  static pruefeProfil(p) {
    if (!/^https:\/\/www\.immobilienscout24\.de\//.test(p.url || ''))
      return `Profil „${p.name}“: Die Such-Adresse muss mit https://www.immobilienscout24.de/ beginnen.`;
    if (!(p.mieteQm > 0)) return `Profil „${p.name}“: Bitte die erwartete Kaltmiete (€/m² Monat) eintragen.`;
    return '';
  }
}

// Prüft ein bewertetes Objekt gegen die Kriterien. Leere Kriterien werden ignoriert,
// unbekannte Werte (z. B. Zimmerzahl) lassen ein Objekt nicht durchfallen.
class Kriterien {
  static passt(o, analyse, kr) {
    const gesetzt = v => v !== null && v !== undefined && v !== '';
    const k = analyse.k, sc = analyse.score;
    const regeln = [
      [sc && sc.wert >= (kr.minScore || 0), 'Score zu niedrig'],
      [!gesetzt(kr.minBrutto) || (k.bruttoRendite !== null && k.bruttoRendite >= kr.minBrutto), 'Bruttomietrendite zu niedrig'],
      [!gesetzt(kr.maxPreis) || !(o.kaufpreis > kr.maxPreis), 'Kaufpreis zu hoch'],
      [!gesetzt(kr.minFlaeche) || !(o.wohnflaeche < kr.minFlaeche), 'Wohnfläche zu klein'],
      [!gesetzt(kr.maxFlaeche) || !(o.wohnflaeche > kr.maxFlaeche), 'Wohnfläche zu groß'],
      [!gesetzt(kr.minZimmer) || !(o.zimmer != null && o.zimmer < kr.minZimmer), 'zu wenige Zimmer'],
      [!kr.energieSchlechtestens || ENERGIEKLASSEN.indexOf(o.energieklasse) <= ENERGIEKLASSEN.indexOf(kr.energieSchlechtestens), 'Energieklasse zu schlecht']
    ];
    const fehler = regeln.find(([ok]) => !ok);
    return {passt: !fehler, grund: fehler ? fehler[1] : ''};
  }
}

/* =====================================================================
   PERSISTENZ
   ===================================================================== */
class Speicher {
  static laden() { try { const r = localStorage.getItem(SPEICHER_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  static speichern(s) { try { localStorage.setItem(SPEICHER_KEY, JSON.stringify(s)); } catch (e) { /* z. B. privater Modus */ } }
}

/* =====================================================================
   IMPORT: Inserat-Text (z. B. aus ImmoScout kopiert) -> Objektfelder
   Arbeitet nur mit dem Text, den die Person selbst einfügt (keine Abfrage der Website).
   ===================================================================== */
class InseratParser {
  // Deutsche Zahl "1.234,56" -> 1234.56
  static zahl(s) {
    if (s == null) return null;
    const v = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isNaN(v) ? null : v;
  }

  // Liest den Inseratstext und liefert erkannte Felder, Annahmen und fehlende Pflichtangaben
  static parse(text, opt = {}) {
    const t = String(text || '').replace(/ /g, ' ');
    const z = InseratParser.zahl;
    const m = re => t.match(re);
    const felder = {}, erkannt = [], annahmen = [];
    const setze = (k, label, v) => {
      if (v != null && v !== '' && !(typeof v === 'number' && isNaN(v))) { felder[k] = v; erkannt.push(label); }
    };
    const ZAHL = '([\\d.]*\\d(?:,\\d+)?)';

    // Titel: erste sinnvolle Zeile
    const titel = t.split('\n').map(s => s.trim()).find(s => s.length > 3 && s.length < 120 && !/^https?:/i.test(s));
    if (titel) felder.name = titel;

    // Kaufpreis (Fallback: erster Betrag über 20.000 €)
    let x = m(/Kaufpreis[^\d]{0,25}([\d.]+(?:,\d+)?)\s*(?:€|EUR)/i);
    let kp = x ? z(x[1]) : null;
    if (!kp) {
      const alle = [...t.matchAll(/([\d.]{5,}(?:,\d+)?)\s*(?:€|EUR)/g)].map(a => z(a[1])).filter(v => v >= 20000);
      kp = alle[0] || null;
    }
    setze('kaufpreis', 'Kaufpreis', kp);

    // Flächen und Zimmer
    x = m(new RegExp('Wohnfl[aä]che[^\\d]{0,25}' + ZAHL, 'i'));            setze('wohnflaeche', 'Wohnfläche', x ? z(x[1]) : null);
    x = m(new RegExp('Grundst[uü]cksfl[aä]che[^\\d]{0,25}' + ZAHL, 'i')); setze('grundstueck', 'Grundstück', x ? z(x[1]) : null);
    x = m(/(\d+(?:,\d)?)[\s-]*Zimmer/i) || m(/Zimmer(?:anzahl)?[^\d]{0,15}(\d+(?:,\d)?)/i);
    setze('zimmer', 'Zimmer', x ? z(x[1]) : null);

    // Baujahr
    x = m(/Baujahr[^\d]{0,25}(1[6-9]\d\d|20\d\d)/i);
    setze('baujahr', 'Baujahr', x ? parseInt(x[1], 10) : null);

    // Energie
    x = m(/Energieeffizienzklasse[\s:]{0,10}(A\+|[A-H])(?![\wäöüß])/);
    setze('energieklasse', 'Energieklasse', x ? x[1] : null);
    x = m(/(?:Endenergiebedarf|Endenergieverbrauch|Energieverbrauchskennwert|Energiebedarf)[^\d]{0,30}(\d+(?:[.,]\d+)?)\s*kWh/i);
    setze('energiekennwert', 'Energiekennwert', x ? z(x[1]) : null);
    const hz = ((m(/Heizungsart[\s:]{0,5}([^\n]{0,60})/i) || [])[1] || '') + ' '
             + ((m(/Befeuerung\w*[\s:]{0,5}([^\n]{0,40})/i) || [])[1] || '');
    const hmap = [[/Fernw[aä]rme/i, 'Fernwärme'], [/W[aä]rmepumpe/i, 'Wärmepumpe'], [/Pellet|Holz/i, 'Pellets / Holz'],
                  [/Öl/i, 'Öl'], [/Gas/i, 'Gas'], [/Strom|elektr/i, 'Strom']];
    const h = hmap.find(([re]) => re.test(hz));
    if (h) setze('heizung', 'Heizung', h[1]);

    // Laufende Kosten: Hausgeld -> nicht umlagefähiger Anteil (Schätzung 30 %)
    x = m(new RegExp('Hausgeld[^\\d]{0,25}' + ZAHL + '\\s*(?:€|EUR)', 'i'));
    const hg = x ? z(x[1]) : null;
    if (hg) {
      felder.nichtUml = Math.round(hg * 0.3); erkannt.push('Hausgeld');
      annahmen.push(`Nicht umlagefähige Kosten = 30 % des Hausgelds (${Math.round(hg)} €), bitte prüfen`);
    }

    // Miete (bei vermieteten Objekten); Jahresangaben werden auf Monate umgerechnet
    x = m(new RegExp('(Mieteinnahmen|Nettokaltmiete|Kaltmiete)([^\\d]{0,25})' + ZAHL + '\\s*(?:€|EUR)', 'i'));
    if (x) {
      let mt = z(x[3]); if (/p\.\s?a\.|Jahr/i.test(x[2])) mt /= 12;
      setze('kaltmiete', 'Miete', Math.round(mt));
    }

    // Käuferprovision
    if (/provisionsfrei|keine\s+(?:K[aä]ufer)?provision/i.test(t)) { felder.makler = 0; erkannt.push('Provision'); }
    else { x = m(/Provision[^\d\n]{0,50}(\d+(?:,\d+)?)\s*%/i); setze('makler', 'Provision', x ? z(x[1]) : null); }

    // Objektart
    if (/Mehrfamilienhaus|Zinshaus/i.test(t)) setze('art', 'Objektart', 'Mehrfamilienhaus');
    else if (/Einfamilienhaus|Reihenhaus|Doppelhaus|Reihenmittel|Reiheneck/i.test(t)) setze('art', 'Objektart', 'Einfamilienhaus');
    else if (/Wohnung/i.test(t)) setze('art', 'Objektart', 'Eigentumswohnung');

    // Ort: erste PLZ mit Ortsname (ohne Betragsangaben wie "65000 Euro")
    const ort = [...t.matchAll(/\b(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+(?: [A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+)*)/g)]
      .find(a => !/^(Euro|EUR)$/.test(a[2].split(' ')[0]));
    if (ort) setze('ort', 'Lage', ort[1] + ' ' + ort[2]);

    // Zustand aus Stichworten (1 sanierungsbedürftig ... 5 neuwertig)
    let zu = null;
    if (/sanierungsbed[üu]rftig|renovierungsbed[üu]rftig|Renovierungsbedarf|Sanierungsbedarf|Modernisierungsbedarf|Bastler/i.test(t)) zu = 2;
    else if (/Erstbezug|Neubau|kernsaniert|neuwertig/i.test(t)) zu = 5;
    else if (/saniert|modernisiert|renoviert/i.test(t)) zu = 4;
    if (zu) setze('zustand', 'Zustand', zu);

    // Link zum Inserat
    const urls = t.match(/https?:\/\/[^\s)"']+/g) || [];
    const link = (opt.url || '') || urls.find(u => /expose/i.test(u)) || '';
    if (link) felder.link = link;

    // Annahmen aus den Import-Einstellungen
    if (!felder.kaltmiete && felder.wohnflaeche && opt.mieteQm > 0) {
      felder.kaltmiete = Math.round(felder.wohnflaeche * opt.mieteQm);
      annahmen.push(`Miete geschätzt: ${opt.mieteQm} €/m² × ${felder.wohnflaeche} m²`);
    }
    if (opt.marktQm > 0) felder.marktpreis = opt.marktQm;
    if (opt.mieteQm > 0) felder.vergleichsmiete = opt.mieteQm;

    const pflicht = [['kaufpreis', 'Kaufpreis'], ['wohnflaeche', 'Wohnfläche'], ['kaltmiete', 'Miete'],
                     ['baujahr', 'Baujahr'], ['energieklasse', 'Energieklasse']];
    const fehlend = pflicht.filter(([k]) => !felder[k]).map(([, l]) => l);
    return {felder, erkannt, annahmen, fehlend};
  }

  // Erzeugt aus dem Text ein fertiges Objekt (Bundesland bestimmt die Grunderwerbsteuer)
  static alsImmobilie(text, opt = {}) {
    const p = InseratParser.parse(text, opt);
    const bl = BUNDESLAENDER[opt.bundesland] ? opt.bundesland : 'NW';
    const o = Immobilie.normalisiere(Object.assign({bundesland:bl, grest:BUNDESLAENDER[bl][1]}, p.felder));
    o.erkanntAm = new Date().toISOString();            // Zeitpunkt der ersten Erkennung
    o.notizen = ['Importiert am ' + new Date().toLocaleDateString('de-DE'), ...p.annahmen,
                 p.fehlend.length ? 'Nicht erkannt: ' + p.fehlend.join(', ') : ''].filter(Boolean).join('\n');
    return {objekt:o, erkannt:p.erkannt, fehlend:p.fehlend};
  }
}

// Für Node (automatische Suche); im Browser ohne Wirkung
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {BUNDESLAENDER, Immobilie, Rechner, Tilgungsplan, Finanzierung, Bewertung, InseratParser,
                    Einstellungen, Kriterien, Fmt};
}
