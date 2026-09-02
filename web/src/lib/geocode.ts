// Place search via Photon (komoot's open geocoder, no key needed).

export interface Place {
  label: string;
  detail: string;
  lat: number;
  lon: number;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

export async function searchPlaces(q: string, bias?: { lat: number; lon: number }, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q, limit: "6", lang: "en" });
  if (bias) {
    params.set("lat", String(bias.lat));
    params.set("lon", String(bias.lon));
  }
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal });
  if (!res.ok) return [];
  const j = (await res.json()) as { features: PhotonFeature[] };
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const f of j.features || []) {
    const p = f.properties;
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || p.city || p.country || "";
    const parts = [p.street && p.name !== p.street ? p.street : null, p.district, p.city, p.state, p.country]
      .filter((x): x is string => Boolean(x) && x !== name);
    const detail = Array.from(new Set(parts)).join(", ");
    const key = `${name}|${detail}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({ label: name, detail, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
  }
  return out;
}
