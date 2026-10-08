/**
 * What the host plugin shares with this host's instance plugins: they run in one Node process and import this one
 * module. While `preflights` is above 0, every instance reports each sample at once (§4.1).
 */
export const local = { preflights: 0 };
