// Basemap styles, shared by the live map and the GIF renderer. Only a type
// comes from maplibre here, so this can be imported anywhere.
import type { StyleSpecification } from "maplibre-gl";

export const DAY_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE || "https://tiles.openfreemap.org/styles/positron";
export const NIGHT_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE_NIGHT || "https://tiles.openfreemap.org/styles/dark";

// Satellite view: Esri's World Imagery with its road and place-name
// reference tiles on top. No key needed; attribution is required and shown.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
export const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    imagery: {
      type: "raster",
      tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
    roads: { type: "raster", tiles: [`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
    places: { type: "raster", tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
  },
  layers: [
    { id: "imagery", type: "raster", source: "imagery" },
    { id: "roads", type: "raster", source: "roads", paint: { "raster-opacity": 0.85 } },
    { id: "places", type: "raster", source: "places" },
  ],
};
