/**
 * The studio's rack tally, kept in plain JavaScript beside the firing log.
 *
 * A kiln is loaded rack by rack, and the loading sheet writes down only two things about each one:
 * which rack it is and how many slots went onto it. The wall-mounted tablet reads that sheet three
 * ways. It totals the slots, so the studio knows how full the kiln went in. It grades each rack, so
 * whoever loads the next firing can see at a glance which shelves are packed tightly enough to slow
 * the heat work down. And it lists the racks in load order, lightest first, because the lightest
 * rack is the one that comes up to temperature soonest and so is the one to check first.
 *
 * Every reading comes off the sheet as it stands. Nothing is kept between firings, and ordering the
 * racks hands back a fresh list rather than rearranging the sheet it was given.
 */

/** More slots than this on one rack and the shelves are packed tight enough to hold the heat. */
const PACKED_RACK_SLOTS = 18;

/** More slots than this is a steady rack; at or below it the rack is loaded sparsely. */
const STEADY_RACK_SLOTS = 9;

/**
 * Totals the slots loaded across a set of racks.
 *
 * @param {{ rackId: string, slots: number }[]} racks One row per rack, in loading order.
 * @returns {number} The slots the whole firing carries.
 */
export const tallyRackSlots = (racks) => racks.reduce((total, rack) => total + rack.slots, 0);

/**
 * How tightly one rack is loaded, in the words the tablet prints.
 *
 * @param {{ rackId: string, slots: number }} rack The rack as the loading sheet records it.
 * @returns {string} The grade: packed, steady or sparse.
 */
export const gradeRackDensity = (rack) =>
  rack.slots > PACKED_RACK_SLOTS ? 'packed' : rack.slots > STEADY_RACK_SLOTS ? 'steady' : 'sparse';

/**
 * Weighs two racks against each other by the slots they carry, lightest first.
 *
 * @param {{ rackId: string, slots: number }} left The rack listed earlier on the sheet.
 * @param {{ rackId: string, slots: number }} right The rack listed after it.
 * @returns {number} Below zero when the left rack carries fewer slots, above zero when it carries
 * more, and zero when the two are loaded alike.
 */
export const compareRackLoad = (left, right) => left.slots - right.slots;

/**
 * The racks in load order, lightest first, as a list of their own.
 *
 * The sheet is copied before it is sorted, so the loading order the studio wrote down survives.
 *
 * @param {{ rackId: string, slots: number }[]} racks One row per rack, in loading order.
 * @returns {{ rackId: string, slots: number }[]} The same racks, ordered by the slots they carry.
 */
export const orderRacksByLoad = (racks) => {
  return racks.slice().sort(compareRackLoad);
};
