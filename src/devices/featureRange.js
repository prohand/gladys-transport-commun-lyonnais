// -----------------------------------------------------------------------------
// The numeric range every feature has to carry.
//
// `min` and `max` are optional in the SDK types, but `t_device_feature` in the
// Gladys core declares both columns NOT NULL. A feature published without them
// therefore fails the whole `POST /discovered_device` batch with
//
//   HTTP 422 — t_device_feature.min cannot be null; t_device_feature.max cannot
//   be null
//
// and the device never appears — exactly what the text features of this
// integration ("Next departure line", "Next departures", the Vélo'v "Status")
// used to do, because a range is meaningless for a string and was left out.
//
// The value the core's own UI stores for a text feature is 0/0, so that is what
// is sent here: it satisfies the column without pretending the string has
// bounds. Numeric features declare their real gauge bounds instead.
// -----------------------------------------------------------------------------

/** Spread into any feature whose state is a string rather than a number. */
export const TEXT_FEATURE_RANGE = Object.freeze({ min: 0, max: 0 });
