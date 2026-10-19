// The scroll beats of the journey (components/Journey.tsx), shared with the page (pages/Overview.tsx) so the words and
// captions land on the same frames as the 3D. Kept apart so the page does not pull the 3D chunk into the main bundle.
export const T = {
  zoom: [0.03, 0.17] as const,      // the tablet tips flat and fills the view
  swap: 0.5,                        // tablet -> desktop screen, at full zoom (invisible)
  turn: [0.22, 0.33] as const,      // the astronaut turns its back and drifts in
  words: [0.22, 0.27, 0.31, 0.39] as const, // the headline: in, hold, zoom past
  fly: 0.33,                        // the camera starts to travel
  grid: [0.39, 0.74] as const,      // the lattice tunnel
  blast: [0.74, 0.8] as const,     // the lattice winds into a spiral and blows out like a supernova
  corridor: [0.8, 0.86] as const,   // the astronaut turns to face us and walks up to the glass
  pull: [0.85, 0.9] as const,       // the camera pulls back out of the desktop screen
  crack: [0.905, 0.92] as const,
  burst: [0.92, 0.965] as const,    // the glass breaks and the astronaut climbs out
  drop: [0.965, 1] as const,        // and falls below the page
};
