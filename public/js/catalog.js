// Static game data: lift types, buildings, staff, research, piste difficulty rules.

export const DIFF = [
  { id: 0, key: 'green', name: 'Beginner', color: '#2fae4f', maxGrad: 0.14 },
  { id: 1, key: 'blue', name: 'Easy', color: '#2a6fdb', maxGrad: 0.27 },
  { id: 2, key: 'red', name: 'Intermediate', color: '#d6322e', maxGrad: 0.42 },
  { id: 3, key: 'black', name: 'Expert', color: '#16181d', maxGrad: 0.75 },
];
export const MAX_PISTE_GRAD = 1.0; // 45 deg sustained -> unskiable
export function difficultyFromGrad(g) {
  for (const d of DIFF) if (g <= d.maxGrad) return d.id;
  return 3;
}

// capacity in persons/hour, speed m/s, cost = base + perM * length, build days = days + perKm*km
export const LIFTS = {
  carpet: {
    name: 'Magic Carpet', short: 'Carpet', seats: 1, capacity: 900, speed: 0.8, maxLen: 180, maxGrad: 0.25,
    base: 60000, perM: 450, upkeep: 60, power: 15, wind: 999, days: 6, perKm: 0, pylonSpan: 0, surface: true,
    color: '#e8c547', desc: 'Conveyor belt for the first turns of absolute beginners.',
  },
  tbar: {
    name: 'T-Bar Drag Lift', short: 'T-Bar', seats: 2, capacity: 1100, speed: 3, maxLen: 1600, maxGrad: 0.6, surface: true,
    base: 350000, perM: 700, upkeep: 260, power: 90, wind: 85, days: 18, perKm: 10, pylonSpan: 90,
    color: '#c79a38', desc: 'Cheap and wind-proof. Beginners fall off, snowboarders hate it.',
  },
  chair2: {
    name: 'Fixed-Grip Double Chair', short: 'Chair 2', seats: 2, capacity: 1200, speed: 2.3, maxLen: 2000, maxGrad: 0.9,
    base: 1400000, perM: 1100, upkeep: 600, power: 160, wind: 60, days: 35, perKm: 15, pylonSpan: 110,
    color: '#5f86b5', desc: 'Old-school, slow and cold. Cheap to build.',
  },
  chair4: {
    name: 'Detachable Quad Chair', short: 'Quad', seats: 4, capacity: 2400, speed: 5, maxLen: 2800, maxGrad: 0.9,
    base: 4200000, perM: 1700, upkeep: 1300, power: 320, wind: 65, days: 50, perKm: 18, pylonSpan: 130,
    color: '#3a74c4', desc: 'The workhorse of modern resorts.',
  },
  chair6: {
    name: '6-Seat Bubble Chair', short: 'Bubble 6', seats: 6, capacity: 3200, speed: 6, maxLen: 3200, maxGrad: 0.95,
    base: 7500000, perM: 2100, upkeep: 1900, power: 420, wind: 70, days: 60, perKm: 20, pylonSpan: 140,
    color: '#2b5ea8', research: 'bubble', desc: 'Heated seats and weather bubbles. Guests love it.',
  },
  gondola: {
    name: '10-Person Gondola', short: 'Gondola', seats: 10, capacity: 3000, speed: 6, maxLen: 6500, maxGrad: 1.1,
    base: 9000000, perM: 3000, upkeep: 2400, power: 480, wind: 70, days: 75, perKm: 22, pylonSpan: 220,
    color: '#d04f3c', research: 'gondola', desc: 'Comfortable, long, carries pedestrians. Closes in strong wind.',
  },
  cablecar: {
    name: 'Aerial Tramway', short: 'Cable Car', seats: 100, capacity: 900, speed: 11, maxLen: 4500, maxGrad: 3.5,
    base: 13000000, perM: 3600, upkeep: 2600, power: 600, wind: 90, days: 100, perKm: 25, pylonSpan: 1200,
    color: '#b23a3a', desc: 'Two big cabins over cliffs and huge spans. Low capacity, spectacular rides.',
  },
  tram3s: {
    name: '3S Cable Car', short: '3S', seats: 30, capacity: 4000, speed: 7.5, maxLen: 8000, maxGrad: 2.0,
    base: 26000000, perM: 5200, upkeep: 4200, power: 900, wind: 105, days: 140, perKm: 30, pylonSpan: 700,
    color: '#8e2c46', research: 'tri', desc: 'Tri-cable gondola: high capacity, runs in almost any wind.',
  },
};

// Building types. size = footprint radius (m) used for placement + rendering scale.
export const BUILDINGS = {
  base: {
    name: 'Base Station', cat: 'base', cost: 1800000, upkeep: 900, size: 30, days: 30, h: 12, color: '#c9a77c',
    desc: 'Ticket office, lockers and car park. Guests arrive here. Lifts and pistes ending nearby connect to it.',
    parking: 1200,
  },
  parking: {
    name: 'Car Park', cat: 'base', cost: 600000, upkeep: 150, size: 40, days: 15, h: 1, color: '#7c7f86',
    desc: 'More room for day visitors. Place close to a base station.', parking: 900,
  },
  rental: {
    name: 'Ski Rental', cat: 'service', cost: 450000, upkeep: 250, size: 12, days: 15, h: 7, color: '#d9784b',
    desc: 'Rents skis and boards. Earns per guest and makes beginners happier.', service: 'rental', seats: 120, spend: 38, dwell: 15,
  },
  school: {
    name: 'Ski School', cat: 'service', cost: 700000, upkeep: 350, size: 14, days: 18, h: 7, color: '#e8b94a',
    desc: 'Instructors teach beginners. Needs instructors on staff.', service: 'school', seats: 80, spend: 65, dwell: 120,
  },
  hut: {
    name: 'Mountain Hut (Rifugio)', cat: 'food', cost: 1400000, upkeep: 500, size: 14, days: 40, h: 9, color: '#8a5a3b',
    desc: 'Traditional food with a view. Guests love a good rifugio.', service: 'food', seats: 90, spend: 28, dwell: 50, charm: 1.2,
  },
  restaurant: {
    name: 'Self-Service Restaurant', cat: 'food', cost: 2600000, upkeep: 1100, size: 22, days: 45, h: 11, color: '#a7754e',
    desc: 'High-capacity lunch. Less charm, more seats.', service: 'food', seats: 280, spend: 22, dwell: 40, charm: 0.9,
  },
  cafe: {
    name: 'Snack Bar', cat: 'food', cost: 350000, upkeep: 180, size: 8, days: 12, h: 5, color: '#c58a5d',
    desc: 'Quick coffee and strudel.', service: 'food', seats: 30, spend: 9, dwell: 15, charm: 1,
  },
  apres: {
    name: 'Après-Ski Bar', cat: 'food', cost: 900000, upkeep: 400, size: 14, days: 20, h: 8, color: '#d0453c',
    desc: 'Music and spritz after the last run. Big fun bonus near a base.', service: 'apres', seats: 160, spend: 30, dwell: 60, charm: 1.3,
  },
  toilet: {
    name: 'Toilets', cat: 'service', cost: 120000, upkeep: 60, size: 5, days: 6, h: 4, color: '#9fb4c7',
    desc: 'Every guest eventually needs one.', service: 'toilet', seats: 20, spend: 0, dwell: 4,
  },
  patrol: {
    name: 'Ski Patrol & First Aid', cat: 'safety', cost: 500000, upkeep: 250, size: 9, days: 15, h: 6, color: '#e23b3b',
    desc: 'Base for patrollers: faster rescues, avalanche control. Covers 4 km around it.', radius: 4000,
  },
  garage: {
    name: 'Snowcat Garage', cat: 'safety', cost: 800000, upkeep: 300, size: 16, days: 20, h: 8, color: '#e07b22',
    desc: 'Houses up to 5 snowcats for night grooming.', snowcats: 5,
  },
  reservoir: {
    name: 'Snowmaking Reservoir', cat: 'snow', cost: 2200000, upkeep: 400, size: 45, days: 45, h: 0.5, color: '#4fa7d8',
    desc: 'Water storage for snow cannons. Each supports about 15 km of snowmaking pistes.', water: 15000,
  },
  weather: {
    name: 'Weather Station', cat: 'snow', cost: 250000, upkeep: 80, size: 5, days: 8, h: 6, color: '#cfd8df',
    desc: 'Better forecasts: 5 days ahead and more accurate.',
  },
  gazex: {
    name: 'Avalanche Towers', cat: 'safety', cost: 900000, upkeep: 120, size: 6, days: 20, h: 6, color: '#ff7a1a',
    desc: 'Remote avalanche triggering: cuts avalanche risk on pistes within 1.5 km.', radius: 1500, research: 'gazex',
  },
  hotel: {
    name: 'Hotel ★★★', cat: 'lodging', cost: 9000000, upkeep: 2200, size: 26, days: 120, h: 22, color: '#dfcfb4',
    desc: '120 beds. Guests pay per night and ski at your resort.', beds: 120, nightly: 140,
  },
  hotel5: {
    name: 'Luxury Hotel ★★★★★', cat: 'lodging', cost: 28000000, upkeep: 6500, size: 34, days: 180, h: 28, color: '#efe3cf',
    desc: '160 luxury beds. Raises your fame among wealthy guests.', beds: 160, nightly: 520, fame: 2,
  },
  chalet: {
    name: 'Mountain Chalets', cat: 'lodging', cost: 3500000, upkeep: 700, size: 22, days: 60, h: 10, color: '#a87b55',
    desc: '40 ski-in/ski-out beds. Very popular, pricey.', beds: 40, nightly: 260,
  },
  viewpoint: {
    name: 'Panorama Terrace', cat: 'fun', cost: 1200000, upkeep: 200, size: 12, days: 25, h: 4, color: '#9ad1e0',
    desc: 'Summit terrace for sightseers. Pedestrians buy lift tickets to come up. Best on high peaks.', sightseers: 1,
  },
  terrainpark: {
    name: 'Terrain Park', cat: 'fun', cost: 1500000, upkeep: 700, size: 60, days: 25, h: 3, color: '#30c2b2',
    desc: 'Kickers, rails and boxes. Young riders love it. Needed for freestyle events.',
  },
  halfpipe: {
    name: 'Superpipe', cat: 'fun', cost: 2500000, upkeep: 900, size: 70, days: 30, h: 3, color: '#4bd6e6',
    desc: '22-foot halfpipe. Olympic requirement.',
  },
  grandstand: {
    name: 'Finish Stadium', cat: 'events', cost: 3500000, upkeep: 500, size: 40, days: 45, h: 12, color: '#7c62c9',
    desc: 'Grandstands and TV towers at a race finish. Required to host races. Place near the finish of a race piste.',
  },
  icearena: {
    name: 'Olympic Ice Arena', cat: 'events', cost: 45000000, upkeep: 8000, size: 60, days: 300, h: 22, color: '#bfd9ef',
    desc: 'Curling, hockey and skating. Olympic requirement.',
  },
  slidingcenter: {
    name: 'Sliding Centre', cat: 'events', cost: 80000000, upkeep: 12000, size: 90, days: 400, h: 6, color: '#a6b4c2',
    desc: 'Bobsleigh, luge and skeleton track. Olympic requirement. Very expensive to maintain.',
  },
  skijump: {
    name: 'Ski Jumping Hill', cat: 'events', cost: 30000000, upkeep: 3000, size: 70, days: 250, h: 40, color: '#d5dde4',
    desc: 'Large hill HS140. Olympic requirement. Must be built on a steep slope.', minSlope: 18,
  },
  nordic: {
    name: 'Nordic Centre', cat: 'events', cost: 12000000, upkeep: 1500, size: 70, days: 150, h: 8, color: '#89b37a',
    desc: 'Cross-country and biathlon stadium with 30 km of trails. Must be on flat ground.',
  },
  helipad: {
    name: 'Helipad', cat: 'safety', cost: 1500000, upkeep: 900, size: 12, days: 20, h: 1, color: '#e8e8e8',
    desc: 'Rescue helicopter: much faster rescue anywhere. Also sells heli-skiing to experts.',
  },
};

export const BUILD_CATS = [
  { id: 'base', name: 'Base & Access' },
  { id: 'food', name: 'Food & Fun' },
  { id: 'service', name: 'Services' },
  { id: 'lodging', name: 'Lodging' },
  { id: 'safety', name: 'Safety & Grooming' },
  { id: 'snow', name: 'Snow & Weather' },
  { id: 'fun', name: 'Parks & Views' },
  { id: 'events', name: 'Event Venues' },
];

export const STAFF = {
  patrol: { name: 'Ski Patrollers', wage: 210, desc: 'Rescue injured guests, mark hazards, run avalanche control. 1 per ~6 km of piste.' },
  mechanic: { name: 'Lift Mechanics', wage: 240, desc: 'Prevent and repair lift breakdowns. 1 per ~3 lifts.' },
  instructor: { name: 'Ski Instructors', wage: 190, desc: 'Teach in the ski school. Each handles ~8 pupils.' },
  host: { name: 'Hospitality Staff', wage: 150, desc: 'Cooks, waiters and cleaners for huts, restaurants and toilets. 1 per ~40 seats.' },
};
export const SNOWCAT = { cost: 420000, upkeep: 180, wage: 230, kmPerNight: 9 };
export const LIFT_OPERATOR_WAGE = 170; // 2 operators per lift, automatic

export const RESEARCH = [
  { id: 'rfid', name: 'RFID Gates', cost: 600000, days: 20, desc: 'Hands-free gates: +8% lift capacity, shorter queues.' },
  { id: 'bubble', name: 'Bubble Chairs', cost: 1500000, days: 35, desc: 'Unlocks the 6-seat bubble chairlift.' },
  { id: 'gondola', name: 'Monocable Gondolas', cost: 2000000, days: 40, desc: 'Unlocks 10-person gondolas.' },
  { id: 'cannons', name: 'Efficient Snow Guns', cost: 1800000, days: 40, desc: 'Snowmaking works up to -1°C and costs 30% less.' },
  { id: 'winch', name: 'Winch Snowcats', cost: 1200000, days: 30, desc: 'Groom black pistes properly: no more ice on the steeps.' },
  { id: 'app', name: 'Resort App', cost: 800000, days: 25, desc: 'Live queue times on phones: guests spread out, +satisfaction.' },
  { id: 'gazex', name: 'Remote Avalanche Control', cost: 2500000, days: 45, desc: 'Unlocks avalanche towers.' },
  { id: 'solar', name: 'Solar Stations', cost: 2200000, days: 40, desc: '-25% lift energy costs. Eco reputation bonus.' },
  { id: 'tri', name: 'Tri-Cable Technology', cost: 6000000, days: 80, requires: 'gondola', desc: 'Unlocks 3S cable cars.' },
  { id: 'snowfarm', name: 'Snow Farming', cost: 2000000, days: 50, requires: 'cannons', desc: 'Store snow over summer: early-season pistes open with 40 cm base.' },
  { id: 'led', name: 'LED Night Lighting', cost: 900000, days: 20, desc: 'Night skiing on lit pistes is cheaper and more popular.' },
  { id: 'heated', name: 'Heated Seats', cost: 700000, days: 15, requires: 'bubble', desc: 'Chairlift rides on very cold days no longer annoy guests.' },
];

export const PISTE_COST = { perM: 90, forestPerM: 160, snowmakingPerM: 520, lightingPerM: 210, width: 40, days: 10, perKm: 8 };

export const SKILLS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];
// share of each skill in the visitor mix
export const SKILL_MIX = [0.22, 0.38, 0.28, 0.12];
// preferred difficulty weight [skill][difficulty]
export const DIFF_PREF = [
  [1.0, 0.45, 0.0, 0.0],
  [0.35, 1.0, 0.55, 0.03],
  [0.08, 0.55, 1.0, 0.6],
  [0.02, 0.2, 0.75, 1.0],
];
export const SKI_SPEED = [5, 8.5, 11.5, 14]; // m/s average on a piste
