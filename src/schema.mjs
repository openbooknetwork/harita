// Shapes of the map's content files: the harita fields of story.yaml and page.yaml, and the files under shared/ and
// in the page folders. The book's own fields are kitap's. Cross references between files are checked in engine.mjs.
import { z } from 'zod';
import { schema } from '@openbooknetwork/kitap';

const { Translatable, Id, Lang, Hex, StoryCore, check } = schema;
export { Translatable, check };
const Lon = z.number().min(-180).max(180);
const Lat = z.number().min(-90).max(90);
export const Bbox = z.tuple([Lon, Lat, Lon, Lat]).refine(([w, s, e, n]) => w < e && s < n, 'bbox is [west, south, east, north]');

// The map's fields of story.yaml, under harita:
export const StoryMap = z.object({
  extent: Bbox,
  land: z.array(z.string()).min(1),
  countries: z.array(z.string()).min(1),
  hillshade: z.string().optional(), // read by harita 0.2.4 and earlier; the build asks for its removal
  // aliases: battle family ids that take this family's colours, for a battle that names the side another way
  families: z.record(Id, z.object({ priority: z.number().int(), color: Hex, color_dark: Hex.optional(), pattern: z.enum(['hatch', 'cross', 'dots']).optional(), aliases: z.array(Id).optional() }).strict()),
  smoothing: z.number().int().min(0).max(10).default(4),
  max_zoom: z.number().min(11).max(16).default(11), // a battle's pages may zoom closer, and the relief tiles follow to zoom 15
  // country names on the map; names overrides the Natural Earth name, hide leaves a country unlabelled
  labels: z.object({ countries: z.boolean().default(false), names: z.record(z.string(), Translatable).default({}), hide: z.array(z.string()).default([]) }).strict().optional(),
}).strict();
// story.yaml whole, as harita's own commands read it: the book's fields and the map's
export const Story = z.object({ ...StoryCore, harita: StoryMap }).strict();
// a story.yaml from before the split writes the map's fields at the top level; they read as if under harita:
export function liftStory(data) {
  if (!data || typeof data !== 'object') return data;
  for (const k of Object.keys(StoryMap.shape)) if (k in data && !(k in (data.harita ?? {}))) { (data.harita ??= {})[k] = data[k]; delete data[k]; }
  return data;
}

// A tilted 3D view over the terrain: pitch from straight down, bearing clockwise from north, heights times exaggeration.
export const Camera = z.object({ pitch: z.number().min(10).max(60).default(50), bearing: z.number().min(-180).max(180).default(0), exaggeration: z.number().min(0.5).max(5).default(2) }).strict();

// The map's fields of page.yaml, under harita:
export const PageMap = z.object({
  bbox: Bbox,
  zones: z.array(Id).default([]),
  routes: z.array(z.union([Id, z.array(Id).min(2)])).default([]), // a list in the list: routes travelled at once, one leg
  markers: z.array(Id).default([]),
  battle: z.union([Id, z.literal(true)]).optional(), // one battle per page keeps the map readable, and a battle's own page writes true
  camera: z.union([z.literal(false), Camera]).optional()
    .refine(c => c !== false, 'pages open flat until the reader picks 3D, so camera: false has no use: remove it'),
  // an emblem drawn on the map while the page is open: plugins/emblems/<kind>.mjs, else one harita ships
  emblem: z.object({ kind: Id }).passthrough().optional(),
  // map data the page draws beyond the base map, credited in an "Other sources" popup on the map
  map_sources: z.array(z.object({ text: Translatable, url: z.string().url().optional() }).strict()).default([]),
}).strict();

// The battle-plan emblem: troops, movements, water and works at one moment of a battle. Sizes are in metres.
export const UNIT_TYPES = ['infantry', 'cavalry', 'knights', 'pikes', 'light', 'archers', 'irregular', 'elephants', 'chariots', 'siege', 'artillery',
  'armour', 'aircraft', 'ships', 'submarines', 'camp', 'square', 'fort', 'wagons', 'wagon-fort', 'handguns', 'pavises'];
const LngLat = z.tuple([Lon, Lat]);
const Piece = { name: Translatable.optional(), id: z.string().min(1).optional() }; // a named piece shows on pointing
const PlanSide = z.string().min(1); // a family of the story, neutral or a hex colour, checked when drawing
const Size = z.number().positive();
export const BattlePlan = z.object({
  kind: z.literal('battle-plan'),
  land: z.array(z.object({ area: z.array(LngLat).min(3) }).strict()).default([]),
  water: z.array(z.union([
    z.object({ path: z.array(LngLat).min(2), width: Size.optional(), ...Piece }).strict(),
    z.object({ area: z.array(LngLat).min(3), ...Piece }).strict(),
  ])).default([]),
  works: z.array(z.object({ side: PlanSide.optional(), path: z.array(LngLat).min(2), width: Size.optional(), style: z.enum(['wall', 'trench']).optional(), ...Piece }).strict()).default([]),
  units: z.array(z.object({
    side: PlanSide, type: z.enum(UNIT_TYPES).default('infantry'), at: LngLat, width: Size, depth: Size.optional(),
    facing: z.number().optional(), bow: z.number().optional(), count: z.number().int().positive().optional(), rows: z.number().int().positive().optional(),
    // wagon-fort only: openings at compass bearings from the centre, one wagon wide unless `wagons` says more
    gaps: z.array(z.union([z.number(), z.object({ bearing: z.number(), wagons: z.number().int().positive().optional() }).strict()])).optional(), ...Piece,
  }).strict()).default([]),
  arrows: z.array(z.object({ side: PlanSide, path: z.array(LngLat).min(2), width: Size.optional(), style: z.enum(['solid', 'dashed', 'fire']).optional(), ...Piece }).strict()).default([]),
  clashes: z.array(z.union([LngLat, z.object({ at: LngLat, size: Size.optional() }).strict()])).default([]),
}).strict().refine(p => p.water.length + p.works.length + p.units.length + p.arrows.length + p.clashes.length > 0, 'a battle plan needs water, works, units, arrows or clashes');

export const Markers = z.record(Id, z.object({
  lnglat: z.tuple([Lon, Lat]),
  icon: z.string().default('flag'), // a Lucide icon name, checked in the build
  color: Id.optional(),
  image: Id.optional(),
  label: Translatable,
  note: Translatable.default(''),
}).strict());

// A battle in the shape of a Wikipedia infobox, shown as a card on the map.
const Side = z.object({
  name: Translatable,
  color: z.string().optional(), // a family id or a hex colour
  commanders: z.array(Translatable).default([]),
  strength: Translatable.optional(),
  casualties: Translatable.optional(),
}).strict();
// battle.yaml in a battle folder, content/shared/battles/<id>/ or content/<story>/shared/battles/<id>/
export const Battle = z.object({
  lnglat: z.tuple([Lon, Lat]),
  name: Translatable,
  date: Translatable,
  result: Translatable.optional(),
  sides: z.array(Side).min(1).max(3),
  images: z.array(Id).default([]), // shown in the card in this order, one at a time with arrows
  source: z.string().url().optional(),
  front: z.array(z.tuple([Lon, Lat])).min(2).optional(), // a line drawn while the battle is on the page
  default_language: Lang.default('en'), // the language of the inline strings
  max_zoom: z.number().min(11).max(16).optional(), // for the battle's pages, when it is closer than the story's
  // the colours the battle names, which a story family with the same id or alias replaces
  families: z.record(Id, z.object({ color: Hex, color_dark: Hex.optional() }).strict()).default({}),
}).strict();

// include.yaml: a folder in a story's page tree that places a battle's pages there
export const Include = z.object({
  battle: Id,
  zones: z.array(Id).default([]),   // story zones shown on every page of the battle
  markers: z.array(Id).default([]), // story markers shown on every page of the battle
}).strict();

const Ring = z.array(z.tuple([Lon, Lat])).min(4);
const ZoneProperties = { family: Id, name: Translatable, clip: z.array(z.string()).optional() }; // clip: countries, else the story's land
// a MultiPolygon holds a state whose land lies in parts, such as a town cut off inland, as one zone
const ZoneGeometry = z.discriminatedUnion('type', [z.object({ type: z.literal('Polygon'), coordinates: z.array(Ring).min(1) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(Ring).min(1)).min(1) })]);
export const Zone = z.object({ type: z.literal('Feature'), properties: z.object({ id: Id.optional(), ...ZoneProperties }).strict(), geometry: ZoneGeometry });
// zone.geojson in a shared zone folder, content/shared/zones/<id>/: the folder name is its id
export const SharedZone = z.object({ type: z.literal('Feature'), properties: z.object({ ...ZoneProperties, default_language: Lang.default('en') }).strict(), geometry: ZoneGeometry });
// zones.yaml: zones that take their outline from another zone, of the story or shared, with their own name or family
export const ZoneUses = z.record(Id, z.object({ zone: Id, name: Translatable.optional(), family: Id.optional(), clip: z.array(z.string()).optional() }).strict());
// content/shared/zones/apart.yaml: pairs that cover the same land and stay apart, with the drawings as they were checked
const ZoneRef = z.string().regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/, '<story>/<zone id>, or shared/<zone id>');
const Drawing = z.string().regex(/^[0-9a-f]{64}$/, 'a drawing hash, harita zones --apart writes it');
export const Apart = z.array(z.object({ zones: z.tuple([ZoneRef, ZoneRef]), why: z.string().min(1), drawings: z.tuple([Drawing, Drawing]) }).strict());
export const Route = z.object({
  type: z.literal('Feature'),
  properties: z.object({ id: Id.optional(), name: Translatable, style: z.enum(['solid', 'dashed']).default('solid'), arrows: z.boolean().default(true), offset: z.number().min(-20).max(20).default(0), color: Id.optional() }).strict(),
  geometry: z.object({ type: z.literal('LineString'), coordinates: z.array(z.tuple([Lon, Lat])).min(2) }),
});

