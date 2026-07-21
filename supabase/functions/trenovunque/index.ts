// TrenOvunque — backend edge function
// Serve il frontend e fa da proxy normalizzatore verso i provider ferroviari:
//  - Trenitalia/LeFrecce (prezzi reali; Italia + alcune tratte internazionali)
//  - Transitous / MOTIS v2 (orari Europa, senza prezzi) come fallback
import { STATIONS } from "./stations.ts";
import { searchTrenitalia } from "./trenitalia.ts";
import { searchItalo } from "./italo.ts";
import { searchTransitous } from "./db.ts";

export interface Solution {
  departure: string; // ISO
  arrival: string; // ISO
  durationMin: number;
  changes: number;
  priceEur: number | null;
  trains: string[];
  bookingUrl?: string | null; // dove acquistare (sito dell'operatore)
}

export interface JourneyResult {
  ok: true;
  provider: string;
  solutions: Solution[];
}

export interface StationRef {
  station: string;
  city: string;
  country: string;
  lat: number | null;
  lon: number | null;
}

const FRONTEND_URL = "https://alessio-caruso.github.io/trenovunque/";

// ID stazione Trainline (rivenditore che vende Trenitalia + Italo + estero).
// Serve per costruire un link ai risultati GIÀ compilati (partenza/arrivo/data):
// i siti ufficiali Trenitalia/Italo sono SPA senza deep-link parametrico.
const TL_URN: Record<string, string> = {"Roma Termini":"8544","Milano Centrale":"8490","Torino Porta Nuova":"8567","Venezia Santa Lucia":"8574","Firenze Santa Maria Novella":"8434","Bologna Centrale":"10456","Napoli Centrale":"8497","Bari Centrale":"19401","Palermo Centrale":"19593","Catania Centrale":"19200","Verona Porta Nuova":"8581","Genova Piazza Principe":"8453","Pisa Centrale":"20113","Lecce":"66434","Reggio Calabria Centrale":"8539","Trieste Centrale":"20612","Padova":"74736","La Spezia Centrale":"20898","Salerno":"20259","Foggia":"20074","Pescara Centrale":"19583","Ancona Centrale":"19145","Rimini":"8553","Bolzano":"17484","Trento":"18829","Brescia":"22192","Bergamo":"19334","Como San Giovanni":"18821","Varese":"22091","Novara":"10462","Alessandria":"19284","Parma":"8514","Modena":"8493","Reggio Emilia AV Mediopadana":"22582","Ferrara":"19607","Ravenna":"20053","Perugia":"19581","Terni":"20460","Caserta":"20159","Benevento":"19421","Taranto":"34302","Brindisi":"20183","Cosenza":"19252","Lamezia Terme Centrale":"19814","Messina Centrale":"19880","Siracusa":"20532","Cagliari":"19387","Sassari":"20345","Udine":"20642","Treviso":"20610","Vicenza":"10459","Rovigo":"20518","Mantova":"19851","Cremona":"20764","Piacenza":"8529","Pavia":"19483","Asti":"20216","Cuneo":"20164","Savona":"20326","Imperia Oneglia":"19932","Ventimiglia":"8578","Livorno Centrale":"19457","Grosseto":"20850","Siena":"20640","Arezzo":"19176","Viterbo":"20442","Latina":"19813","Frosinone":"19508","Potenza Città":"21434","Civitavecchia":"20745","Isernia":"19631","Teramo":"20788","Chieti":"19279","Crotone":"20228","Catanzaro Lido":"19229","Vibo Valentia Pizzo":"20957","Paola":"20065","Rossano":"19762","Gioiosa Ionica":"20093","Melito di Porto Salvo":"22435","Palmi":"19797","Gioia Tauro":"20092","Alcamo Diramazione":"19261","Castelvetrano":"19318","Gela":"20919","Vittoria":"22125","Modica":"19790","Ragusa":"20727","Comiso":"19185","Noto":"20050","Avola":"20172","Marsala":"19943","Agrigento Centrale":"20702","Termini Imerese":"20789","Bagheria":"20174","Nuoro":"21480","Oristano":"19586","Porto Torres":"19547","Olbia":"67843","Zürich HB":"6245","Genève":"5335","Lausanne":"6247","Bern":"6300","Basel SBB":"5878","Lugano":"6345","Luzern":"39297","St. Gallen":"6352","Paris Gare de Lyon":"4924","Lyon Part-Dieu":"4676","Marseille Saint-Charles":"4791","Nice Ville":"4839","Toulon":"5304","Cannes":"1180","Antibes":"5749","Nîmes":"2825","Montpellier":"4786","Bordeaux Saint-Jean":"828","Toulouse Matabiau":"5311","Strasbourg":"153","Annecy":"4843","Chambéry":"1339","Grenoble":"3358","München Hauptbahnhof":"7480","Stuttgart Hauptbahnhof":"7710","Frankfurt Hauptbahnhof":"7604","Berlin Hauptbahnhof":"7630","Köln Hauptbahnhof":"7561","Hamburg Hauptbahnhof":"7474","Dortmund Hauptbahnhof":"7573","Essen Hauptbahnhof":"7591","Düsseldorf Hauptbahnhof":"7475","Wien Hauptbahnhof":"22644","Innsbruck Hauptbahnhof":"10464","Salzburg Hauptbahnhof":"17458","Graz Hauptbahnhof":"17497","Linz Hauptbahnhof":"17500","Klagenfurt Hauptbahnhof":"17499","Ljubljana":"19094","Maribor":"19096","Zagreb Glavna":"67316","Split":"34270","Rijeka":"28231","Barcelona Sants":"6625","Madrid Atocha":"6667","Valencia Joaquín Sorolla":"24493","Sevilla Santa Justa":"24419","Málaga":"6570","Bruxelles Midi":"5893","Amsterdam Centraal":"5894","Rotterdam Centraal":"8670","Utrecht Centraal":"8673","London St Pancras":"STP1555gb","Praha Hlavní Nádraží":"17509","Brno Hlavní Nádraží":"17503","Budapest Keleti":"10502","Debrecen":"18806","København H":"17515","Aarhus":"17513","Stockholm Central":"19102","Göteborg Centralstation":"39754","Warszawa Centralna":"10493","Kraków Główny":"17584","Wrocław Główny":"19080","Gdańsk Główny":"17518","Bratislava Hlavná":"17495"};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

// cache in-memory per invocazioni calde (from|to|date -> risultato)
const cache = new Map<string, { at: number; body: string }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function toRef(stationName: string, country: string): StationRef {
  const known = STATIONS.find((s) => s.station === stationName);
  return known
    ? {
      station: known.station,
      city: known.city,
      country: known.country,
      lat: known.lat,
      lon: known.lon,
    }
    : { station: stationName, city: stationName, country, lat: null, lon: null };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  // path può essere /trenovunque/... o /functions/v1/trenovunque/...
  const path = url.pathname.replace(/^.*?\/trenovunque\/?/, "");

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  // Il frontend vive su GitHub Pages: Supabase riscrive text/html in
  // text/plain per i browser, quindi qui facciamo solo da API + redirect.
  if (path === "" || path === "index.html") {
    return Response.redirect(FRONTEND_URL, 302);
  }

  if (path === "api/stations") {
    // aggiunge l'id Trainline (tl) così il frontend può costruire il link
    // di prenotazione andata+ritorno già compilato.
    const withTl = STATIONS.map((s) => ({ ...s, tl: TL_URN[s.station] ?? null }));
    return json({ ok: true, stations: withTl });
  }

  if (path === "api/journeys") {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    const fromCountry = url.searchParams.get("fromCountry") ?? "IT";
    const toCountry = url.searchParams.get("toCountry") ?? "IT";
    const date = url.searchParams.get("date") ?? "";
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ ok: false, error: "parametri mancanti o non validi" }, 400);
    }

    const key = `${from}|${to}|${date}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return new Response(hit.body, { headers: JSON_HEADERS });
    }

    const fromRef = toRef(from, fromCountry);
    const toRef2 = toRef(to, toCountry);
    const domestic = fromCountry === "IT" && toCountry === "IT";

    let result: JourneyResult | null = null;
    let lastError = "nessun provider disponibile";

    if (domestic) {
      // Tratte italiane: Trenitalia + Italo in parallelo, soluzioni unite.
      const [tre, ita] = await Promise.allSettled([
        searchTrenitalia(fromRef, toRef2, date),
        searchItalo(fromRef, toRef2, date),
      ]);
      const merged: Solution[] = [];
      const labels: string[] = [];
      for (const [name, r] of [["trenitalia", tre], ["italo", ita]] as const) {
        if (r.status === "fulfilled") {
          if (r.value.solutions.length) labels.push(name);
          merged.push(...r.value.solutions);
        } else {
          lastError = r.reason instanceof Error ? r.reason.message : String(r.reason);
        }
      }
      if (merged.length) {
        merged.sort((a, b) => a.departure.localeCompare(b.departure));
        result = {
          ok: true,
          provider: labels.join("+") || "trenitalia",
          solutions: merged.slice(0, 12),
        };
      }
    }

    // Fallback (o tratte estere): Trenitalia poi Transitous per gli orari.
    if (!result) {
      for (const provider of [searchTrenitalia, searchTransitous]) {
        try {
          const r = await provider(fromRef, toRef2, date);
          if (r.solutions.length > 0) {
            result = r;
            break;
          }
          result = result ?? r; // risultato vuoto ma valido
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
    }

    if (!result) return json({ ok: false, error: lastError }, 502);

    // bookingUrl resta il link diretto all'operatore (prezzo reale) impostato
    // dall'adapter; il link Trainline A/R lo costruisce il frontend con
    // entrambe le date e gli id `tl` delle stazioni.
    const body = JSON.stringify(result);
    cache.set(key, { at: Date.now(), body });
    return new Response(body, { headers: JSON_HEADERS });
  }

  return json({ ok: false, error: "not found" }, 404);
});
