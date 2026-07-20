// Adapter Italo / NTV (API BFF non ufficiale del sito di prenotazione).
// Flusso: login (JWT anonimo, riusabile ~1h) -> working-session (id nuovo)
// -> booking (async, 202) -> polling status. Prezzi reali inclusi.
import type { JourneyResult, Solution, StationRef } from "./index.ts";

const LOGIN = "https://biglietti.italotreno.com/api/login";
const API = "https://api-biglietti.italotreno.com/api/v1";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ORIGIN = "https://biglietti.italotreno.com";

// Mappa nome-stazione (dataset TrenOvunque) -> codice stazione Italo.
// Costruita per prossimità di coordinate sui dati ufficiali Italo.
const CODES: Record<string, string> = {
  "Roma Termini": "RMT", "Milano Centrale": "MC_", "Torino Porta Nuova": "TOP",
  "Venezia Santa Lucia": "VSL", "Firenze Santa Maria Novella": "SMN",
  "Bologna Centrale": "BC_", "Napoli Centrale": "NAC", "Bari Centrale": "BAC",
  "Palermo Centrale": "PA_", "Catania Centrale": "CTC", "Verona Porta Nuova": "VPN",
  "Genova Piazza Principe": "G__", "Pisa Centrale": "PSS", "Lecce": "LEE",
  "Reggio Calabria Centrale": "RCE", "Trieste Centrale": "TSC", "Padova": "PD_",
  "La Spezia Centrale": "SPZ", "Salerno": "SAL", "Foggia": "FG_",
  "Pescara Centrale": "PPN", "Ancona Centrale": "FF_", "Rimini": "J__",
  "Bolzano": "BLZ", "Trento": "TCN", "Brescia": "BSC", "Bergamo": "BGM",
  "Como San Giovanni": "COM", "Varese": "VAS", "Novara": "NOV",
  "Alessandria": "ALE", "Parma": "Y__", "Modena": "Q__",
  "Reggio Emilia AV Mediopadana": "AAV", "Ferrara": "F__", "Ravenna": "NN_",
  "Perugia": "PGU", "Terni": "TN_", "Caserta": "CEA", "Benevento": "BEN",
  "Taranto": "TAT", "Brindisi": "BR_", "Cosenza": "COZ",
  "Lamezia Terme Centrale": "LON", "Messina Centrale": "MEC", "Siracusa": "SIR",
  "Udine": "UDN", "Treviso": "TVC", "Vicenza": "VIC", "Rovigo": "R__",
  "Mantova": "MAV", "Cremona": "CRN", "Piacenza": "P__", "Pavia": "P3_",
  "Asti": "AST", "Cuneo": "CUN", "Savona": "N__", "Imperia Oneglia": "IMR",
  "Ventimiglia": "XXM", "Livorno Centrale": "LI_", "Grosseto": "GRS",
  "Siena": "SSN", "Arezzo": "ARZ", "Viterbo": "VPR", "Latina": "LAT",
  "Frosinone": "FRO", "Potenza Città": "PZI", "Civitavecchia": "CVT",
};

// JWT anonimo condiviso tra ricerche (cache modulo, TTL prudenziale ~50min).
let token: { jwt: string; at: number } | null = null;
const TOKEN_TTL_MS = 50 * 60 * 1000;

function randomId(): string {
  const cs = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += cs[Math.floor(Math.random() * cs.length)];
  return s;
}

async function getToken(): Promise<string> {
  if (token && Date.now() - token.at < TOKEN_TTL_MS) return token.jwt;
  const res = await fetch(LOGIN, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      "X-Anonymous-User": "true",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/it/ricerca-biglietto`,
    },
    body: JSON.stringify({ isAnonymous: true, workingId: randomId() }),
  });
  if (!res.ok) throw new Error(`italo login ${res.status}`);
  const cookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") ?? ""];
  const raw = cookies.join("\n");
  const m = raw.match(/BIGSessionToken=([^;\s]+)/);
  if (!m) throw new Error("italo: token non trovato");
  token = { jwt: m[1], at: Date.now() };
  return token.jwt;
}

// deve restare naive->ISO con l'offset corretto di Roma per la data
function romeOffset(date: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const h = tz.match(/GMT([+-]\d{1,2})/)?.[1] ?? "+1";
  return `${h.startsWith("-") ? "-" : "+"}${String(Math.abs(+h)).padStart(2, "0")}:00`;
}

interface ItaloFare {
  paxFares?: { fullPaxFarePrice?: number }[];
}
interface ItaloSegment {
  std?: string;
  sta?: string;
  carrierCode?: string;
  trainNumber?: string;
  fares?: ItaloFare[];
}
interface ItaloJourney {
  segments?: ItaloSegment[];
}
interface ItaloTS {
  journeys?: ItaloJourney[];
  numberOfChanges?: number;
}

export async function searchItalo(
  from: StationRef,
  to: StationRef,
  date: string,
): Promise<JourneyResult> {
  const fromCode = CODES[from.station];
  const toCode = CODES[to.station];
  if (!fromCode || !toCode) throw new Error("stazione non servita da Italo");

  const jwt = await getToken();
  const wid = randomId();
  const headers = {
    "User-Agent": UA,
    Authorization: `Bearer ${jwt}`,
    "X-BIG-working-session-id": wid,
    "Content-Type": "application/json",
    Origin: ORIGIN,
  };

  await fetch(`${API}/working-sessions`, { method: "POST", headers, body: "{}" });

  const startRes = await fetch(`${API}/booking`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      isRoundTrip: false,
      departureStation: fromCode,
      arrivalStation: toCode,
      departureDate: date,
      culture: "it-IT",
      showPrivateOffers: true,
      showBestPrices: true,
      adultPassengers: 1,
      youngPassengers: 0,
      childPassengers: 0,
      seniorPassengers: 0,
      hasPet: false,
      promoCode: "",
      portalType: "B2C",
    }),
  });
  if (!startRes.ok) throw new Error(`italo booking ${startRes.status}`);
  const started = await startRes.json();

  let data = started;
  const opId = started?.operationId;
  if (opId && !started?.trips) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      const st = await fetch(`${API}/booking/status/${opId}`, { headers });
      if (!st.ok) continue;
      data = await st.json();
      if (data?.trips?.[0]?.travelSolutions) break;
    }
  }

  const tsList: ItaloTS[] = data?.trips?.[0]?.travelSolutions ?? [];
  const off = romeOffset(date);

  const solutions: Solution[] = tsList
    .map((ts) => {
      const js = ts.journeys ?? [];
      const segs = js.flatMap((j) => j.segments ?? []);
      if (!segs.length) return null;
      const first = segs[0], last = segs[segs.length - 1];
      if (!first.std || !last.sta) return null;
      const prices: number[] = [];
      for (const seg of segs) {
        for (const f of seg.fares ?? []) {
          for (const pf of f.paxFares ?? []) {
            if (typeof pf.fullPaxFarePrice === "number" && pf.fullPaxFarePrice > 0) {
              prices.push(pf.fullPaxFarePrice);
            }
          }
        }
      }
      const dep = new Date(`${first.std}${off}`);
      const arr = new Date(`${last.sta}${off}`);
      return {
        departure: `${first.std}${off}`,
        arrival: `${last.sta}${off}`,
        durationMin: Math.round((arr.getTime() - dep.getTime()) / 60000),
        changes: ts.numberOfChanges ?? Math.max(0, segs.length - 1),
        priceEur: prices.length ? Math.min(...prices) : null,
        trains: segs.map((s) => `${s.carrierCode ?? "italo"} ${s.trainNumber ?? ""}`.trim()),
      } as Solution;
    })
    .filter((s): s is Solution => s !== null && s.departure.startsWith(date))
    .slice(0, 8);

  return { ok: true, provider: "italo", solutions };
}
