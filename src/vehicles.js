// Vehicle catalogue, upgrade definitions and stat computation.
// Visuals are procedural low-poly by default; `kenney` names an optional GLB from the
// Kenney Car Kit (CC0) that is used instead when present in assets/kenney/car-kit/.

export const VEHICLES = [
  {
    id: 'hatch', name: 'Pip Hatchback', cls: 'Compact', price: 0, kenney: 'hatchback-sports',
    desc: 'Nimble starter car. Forgiving and cheap to upgrade.',
    mass: 1000, power: 15, topSpeed: 46, grip: 1.0, steer: 1.15, offroad: 0.8, brake: 1.0, nitro: 1.0,
    body: { len: 3.9, wid: 1.8, hgt: 0.75, cabLen: 0.55, cabOff: -0.15, cabH: 0.62, wheelR: 0.34, ride: 0.32, style: 'hatch' },
    color: '#e8463a',
  },
  {
    id: 'sedan', name: 'Civic Cruiser', cls: 'Sedan', price: 6000, kenney: 'sedan',
    desc: 'Comfortable all-rounder. Stable at speed.',
    mass: 1350, power: 19, topSpeed: 52, grip: 1.02, steer: 1.0, offroad: 0.8, brake: 1.05, nitro: 1.0,
    body: { len: 4.6, wid: 1.9, hgt: 0.72, cabLen: 0.48, cabOff: -0.05, cabH: 0.6, wheelR: 0.36, ride: 0.32, style: 'sedan' },
    color: '#3a7be8',
  },
  {
    id: 'muscle', name: 'Thunder V8', cls: 'Muscle', price: 18000, kenney: 'sedan-sports',
    desc: 'Huge power, loose rear end. Loves to drift.',
    mass: 1600, power: 30, topSpeed: 62, grip: 0.9, steer: 0.95, offroad: 0.7, brake: 0.95, nitro: 1.2,
    body: { len: 4.9, wid: 2.0, hgt: 0.72, cabLen: 0.4, cabOff: -0.12, cabH: 0.52, wheelR: 0.38, ride: 0.3, style: 'coupe', spoiler: true },
    color: '#f2b705',
  },
  {
    id: 'rally', name: 'Gravel Fox', cls: 'Rally', price: 22000, kenney: 'race',
    desc: 'Rally-bred. Great grip on dirt, sand and snow.',
    mass: 1200, power: 25, topSpeed: 56, grip: 1.08, steer: 1.15, offroad: 1.3, brake: 1.1, nitro: 1.0,
    body: { len: 4.2, wid: 1.85, hgt: 0.8, cabLen: 0.5, cabOff: -0.1, cabH: 0.6, wheelR: 0.38, ride: 0.45, style: 'hatch', spoiler: true },
    color: '#ffffff',
  },
  {
    id: 'sports', name: 'Vento GT', cls: 'Sports', price: 38000, kenney: 'sedan-sports',
    desc: 'Low, sharp and grippy. A corner carver.',
    mass: 1300, power: 33, topSpeed: 70, grip: 1.25, steer: 1.1, offroad: 0.55, brake: 1.3, nitro: 1.1,
    body: { len: 4.5, wid: 2.0, hgt: 0.6, cabLen: 0.38, cabOff: -0.08, cabH: 0.45, wheelR: 0.36, ride: 0.24, style: 'coupe', spoiler: true },
    color: '#22c46e',
  },
  {
    id: 'suv', name: 'Ranger SUV', cls: 'SUV', price: 15000, kenney: 'suv',
    desc: 'Tall and tough. Shrugs off rough terrain.',
    mass: 2100, power: 24, topSpeed: 50, grip: 0.95, steer: 0.85, offroad: 1.25, brake: 0.95, nitro: 0.9,
    body: { len: 4.8, wid: 2.05, hgt: 0.95, cabLen: 0.62, cabOff: -0.08, cabH: 0.75, wheelR: 0.46, ride: 0.55, style: 'suv' },
    color: '#4b5c3a',
  },
  {
    id: 'pickup', name: 'Haul-Rite Pickup', cls: 'Truck', price: 12000, kenney: 'truck',
    desc: 'Workhorse. Bonus pay on delivery jobs.',
    mass: 2300, power: 23, topSpeed: 48, grip: 0.92, steer: 0.82, offroad: 1.15, brake: 0.9, nitro: 0.8, delivery: 1.5,
    body: { len: 5.3, wid: 2.05, hgt: 0.9, cabLen: 0.32, cabOff: 0.12, cabH: 0.72, wheelR: 0.44, ride: 0.5, style: 'pickup' },
    color: '#8a2be2',
  },
  {
    id: 'van', name: 'Parcel Van', cls: 'Van', price: 9000, kenney: 'van',
    desc: 'Slow but pays double on deliveries.',
    mass: 2500, power: 20, topSpeed: 44, grip: 0.9, steer: 0.8, offroad: 0.85, brake: 0.9, nitro: 0.7, delivery: 2.0,
    body: { len: 5.0, wid: 2.05, hgt: 1.25, cabLen: 0.8, cabOff: -0.08, cabH: 0.85, wheelR: 0.38, ride: 0.35, style: 'van' },
    color: '#f0f0f0',
  },
  {
    id: 'monster', name: 'Big Stomp', cls: 'Monster', price: 45000, kenney: 'suv-luxury',
    desc: 'Monster truck. Flattens anything and flies far.',
    mass: 3200, power: 40, topSpeed: 48, grip: 1.0, steer: 0.8, offroad: 1.5, brake: 0.9, nitro: 1.0, smash: 2.5,
    body: { len: 5.0, wid: 2.6, hgt: 1.0, cabLen: 0.5, cabOff: -0.05, cabH: 0.7, wheelR: 0.95, ride: 1.2, style: 'pickup' },
    color: '#ff7f11',
  },
  {
    id: 'hyper', name: 'Aero X Hyper', cls: 'Hypercar', price: 95000, kenney: 'race-future',
    desc: 'The fastest thing on four wheels. Handle with care.',
    mass: 1250, power: 48, topSpeed: 88, grip: 1.35, steer: 1.05, offroad: 0.45, brake: 1.5, nitro: 1.3,
    body: { len: 4.7, wid: 2.1, hgt: 0.55, cabLen: 0.34, cabOff: -0.02, cabH: 0.4, wheelR: 0.36, ride: 0.2, style: 'coupe', spoiler: true },
    color: '#111111',
  },
];

// Upgrade parts: each level multiplies/adds stats. Level 0 is stock.
export const UPGRADES = {
  engine: {
    name: 'Engine', desc: 'More power and a little more top speed.',
    levels: [{ name: 'Stock' }, { name: 'Street', cost: 2500 }, { name: 'Sport', cost: 7000 }, { name: 'Race', cost: 16000 }],
    apply: (s, l) => { s.power *= 1 + 0.15 * l; s.topSpeed *= 1 + 0.05 * l; },
  },
  gearbox: {
    name: 'Gearbox', desc: 'Raises top speed.',
    levels: [{ name: 'Stock' }, { name: 'Close-ratio', cost: 2000 }, { name: 'Sport', cost: 5500 }, { name: 'Sequential', cost: 12000 }],
    apply: (s, l) => { s.topSpeed *= 1 + 0.07 * l; },
  },
  turbo: {
    name: 'Nitro', desc: 'Bigger nitro tank and stronger boost.',
    levels: [{ name: 'Stock' }, { name: 'Small tank', cost: 1500 }, { name: 'Twin tank', cost: 5000 }, { name: 'Race N2O', cost: 11000 }],
    apply: (s, l) => { s.nitroCap *= 1 + 0.35 * l; s.nitroPower *= 1 + 0.15 * l; },
  },
  brakes: {
    name: 'Brakes', desc: 'Stop shorter.',
    levels: [{ name: 'Stock' }, { name: 'Drilled', cost: 1200 }, { name: 'Sport', cost: 3500 }, { name: 'Carbon', cost: 8000 }],
    apply: (s, l) => { s.brake *= 1 + 0.2 * l; },
  },
  suspension: {
    name: 'Suspension', desc: 'Better landings, stability and rough-terrain handling.',
    levels: [{ name: 'Stock' }, { name: 'Lowered', cost: 1800 }, { name: 'Sport', cost: 4500 }, { name: 'Rally', cost: 9000 }],
    apply: (s, l) => { s.stability *= 1 + 0.15 * l; s.offroad *= 1 + 0.05 * l; s.landing *= 1 + 0.25 * l; },
  },
  weight: {
    name: 'Weight Reduction', desc: 'Lighter car accelerates and turns quicker.',
    levels: [{ name: 'Stock' }, { name: 'Stripped', cost: 2000 }, { name: 'Lightweight', cost: 6000 }, { name: 'Carbon body', cost: 14000 }],
    apply: (s, l) => { s.mass *= 1 - 0.08 * l; s.steer *= 1 + 0.04 * l; },
  },
};

export const TIRES = [
  { id: 'street', name: 'Street', cost: 0, road: 1.0, off: 1.0, snow: 1.0, desc: 'Balanced everyday tires.' },
  { id: 'sport', name: 'Sport', cost: 3000, road: 1.15, off: 0.85, snow: 0.85, desc: 'More grip on tarmac, worse off it.' },
  { id: 'slick', name: 'Racing Slicks', cost: 9000, road: 1.32, off: 0.65, snow: 0.55, desc: 'Maximum tarmac grip. Terrible in rain & dirt.', rainPenalty: 0.7 },
  { id: 'offroad', name: 'Off-road', cost: 4000, road: 0.9, off: 1.35, snow: 1.2, desc: 'Knobbly tires for dirt, sand and grass.' },
  { id: 'winter', name: 'Winter Studs', cost: 3500, road: 0.95, off: 1.1, snow: 1.6, desc: 'Bite into snow and ice. Great in bad weather.', rainPenalty: 1.15 },
];

export const PAINTS = [
  '#e8463a', '#ff7f11', '#f2b705', '#22c46e', '#1fb5c9', '#3a7be8', '#8a2be2', '#ff4fa3',
  '#ffffff', '#b8bcc2', '#555a60', '#111111', '#7b4a2a', '#4b5c3a', '#c9a227', '#0a2a66',
];

export const FINISHES = [
  { id: 'gloss', name: 'Gloss', cost: 0, roughness: 0.35, metalness: 0.1 },
  { id: 'metallic', name: 'Metallic', cost: 800, roughness: 0.25, metalness: 0.7 },
  { id: 'matte', name: 'Matte', cost: 800, roughness: 0.9, metalness: 0.0 },
  { id: 'chrome', name: 'Chrome', cost: 5000, roughness: 0.05, metalness: 1.0 },
];

export function vehicleById(id) {
  return VEHICLES.find((v) => v.id === id) || VEHICLES[0];
}

// Compute the effective handling stats for a vehicle with its upgrade setup.
export function computeStats(def, setup = {}) {
  const s = {
    mass: def.mass, power: def.power, topSpeed: def.topSpeed, grip: def.grip, steer: def.steer,
    offroad: def.offroad, brake: def.brake, nitroCap: 4 * def.nitro, nitroPower: 1, stability: 1, landing: 1,
    smash: def.smash || 1, delivery: def.delivery || 1,
  };
  const ups = setup.upgrades || {};
  for (const [k, u] of Object.entries(UPGRADES)) u.apply(s, ups[k] || 0);
  s.tire = TIRES.find((t) => t.id === setup.tires) || TIRES[0];
  // derived acceleration (m/s^2) - power is "kW-ish per tonne" scaled
  s.accel = (s.power * 1000) / s.mass * 0.42;
  return s;
}

// Normalised 0..1 stat ratings for the garage UI.
export function ratings(s) {
  return {
    Speed: Math.min(1, (s.topSpeed - 35) / 75),
    Acceleration: Math.min(1, (s.accel - 4) / 18),
    Handling: Math.min(1, (s.grip * s.tire.road * s.steer - 0.6) / 1.4),
    'Off-road': Math.min(1, (s.offroad * s.tire.off - 0.3) / 1.9),
    Braking: Math.min(1, (s.brake - 0.6) / 2.2),
    Nitro: Math.min(1, (s.nitroCap * s.nitroPower) / 18),
  };
}
