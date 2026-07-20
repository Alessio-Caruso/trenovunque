// Adapter Trenitalia/LeFrecce (API BFF non ufficiale del sito lefrecce.it)
import type { JourneyResult, Solution, StationRef } from "./index.ts";

const BASE = "https://www.lefrecce.it/Channels.Website.BFF.WEB/website";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const locationCache = new Map<string, number | null>();

// LeFrecce traslittera i nomi esteri alla tedesca (Zuerich, Muenchen, Geneve)
// e non capisce le umlaut nelle query.
const translit = (s: string) =>
  s.replace(/ü/g, "ue").replace(/ö/g, "oe").replace(/ä/g, "ae")
    .replace(/Ü/g, "Ue").replace(/Ö/g, "Oe").replace(/Ä/g, "Ae")
    .replace(/ß/g, "ss");

const norm = (s: string) =>
  translit(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/hauptbahnhof/g, "hbf")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

async function queryLocations(name: string) {
  const res = await fetch(
    `${BASE}/locations/search?name=${encodeURIComponent(name)}&limit=10`,
    { headers: { "User-Agent": UA } },
  );
  if (!res.ok) throw new Error(`lefrecce locations ${res.status}`);
  return (await res.json()) as { id: number; name: string }[];
}

// Risolve la stazione provando più query e accettando solo match plausibili,
// per evitare falsi positivi dell'autocomplete su stazioni che LeFrecce
// non conosce (es. "Lione" -> "ANDRANO-CASTIGLIONE").
async function resolveLocation(ref: StationRef): Promise<number | null> {
  const key = norm(ref.station);
  if (locationCache.has(key)) return locationCache.get(key)!;

  const target = norm(ref.station);
  const queries = [
    translit(ref.station).replace(/Hauptbahnhof/g, "Hbf"),
    ref.station.split(/[\s-]/)[0],
    translit(ref.city),
  ];
  let id: number | null = null;
  const seen = new Set<string>();
  for (const query of queries) {
    if (id || seen.has(query.toLowerCase())) continue;
    seen.add(query.toLowerCase());
    const list = await queryLocations(query);
    // 1) match esatto sul nome stazione
    const exact = list.find((l) => norm(l.name) === target);
    // 2) aggregato città ("Zuerich (city)", "Roma ( Tutte Le Stazioni )",
    //    "Paris"): il nome, tolte le parentesi, è prefisso della stazione
    const aggregate = list.find((l) => {
      const base = norm(l.name.replace(/\(.*?\)/g, ""));
      return base.length >= 4 &&
        (target === base || target.startsWith(base + " "));
    });
    id = (exact ?? aggregate)?.id ?? null;
  }
  locationCache.set(key, id);
  return id;
}

interface LfSolution {
  solution: {
    departureTime: string;
    arrivalTime: string;
    status?: string;
    price?: { amount?: number } | null;
    trains?: { name?: string; acronym?: string; trainCategory?: string }[];
    nodes?: unknown[];
  };
}

export async function searchTrenitalia(
  from: StationRef,
  to: StationRef,
  date: string,
): Promise<JourneyResult> {
  const [fromId, toId] = await Promise.all([
    resolveLocation(from),
    resolveLocation(to),
  ]);
  if (!fromId || !toId) throw new Error("stazione non trovata su lefrecce");

  const res = await fetch(`${BASE}/ticket/solutions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      departureLocationId: fromId,
      arrivalLocationId: toId,
      departureTime: `${date}T05:00:00.000+02:00`,
      adults: 1,
      children: 0,
      criteria: {
        frecceOnly: false,
        regionalOnly: false,
        noChanges: false,
        order: "DEPARTURE_DATE",
        limit: 10,
        offset: 0,
      },
      advancedSearchRequest: { bestFare: false },
    }),
  });
  if (!res.ok) throw new Error(`lefrecce solutions ${res.status}`);
  const data = (await res.json()) as { solutions?: LfSolution[] };

  const solutions: Solution[] = (data.solutions ?? [])
    .map((s) => s.solution)
    .filter((s) => s?.departureTime && s?.arrivalTime)
    // solo soluzioni che partono nella data richiesta
    .filter((s) => s.departureTime.startsWith(date))
    .map((s) => {
      const dep = new Date(s.departureTime).getTime();
      const arr = new Date(s.arrivalTime).getTime();
      const price = typeof s.price?.amount === "number" ? s.price.amount : null;
      return {
        departure: s.departureTime,
        arrival: s.arrivalTime,
        durationMin: Math.round((arr - dep) / 60000),
        changes: Math.max(0, (s.nodes?.length ?? 1) - 1),
        priceEur: price,
        trains: (s.trains ?? []).map((t) =>
          [t.acronym ?? t.trainCategory, t.name].filter(Boolean).join(" ")
        ),
      };
    })
    .slice(0, 8);

  return { ok: true, provider: "trenitalia", solutions };
}
