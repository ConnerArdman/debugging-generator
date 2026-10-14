/**
 * Glaze selection for a loaded kiln rack.
 *
 * A studio loads a kiln one shelf at a time and writes the slots down on a
 * loading sheet, lowest shelf first. Which glaze the rack is then fired with
 * follows from what is standing on it rather than from which kiln it went into:
 * a slot's footprint says how much of the bucket the piece in it will draw,
 * bisque ware draws noticeably more of it than greenware, and a slot high in
 * the stack sits nearer the top elements, so it does more heat work than the
 * same slot would on the bottom shelf.
 *
 * Those three readings are combined into a score per slot, and the scores of a
 * whole rack choose the glaze: the coolest one in the studio's book that will
 * still carry the busiest slot, with the soak lengthened for a deep rack, whose
 * middle shelves come up to temperature last. A rack asking for more heat work
 * than the book covers is fired on the house glaze at the top of the range.
 *
 * Every reading comes off the loading sheet, so one sheet always chooses the
 * same glaze, and nothing here keeps anything between racks.
 */

/** Square millimetres of slot footprint worth one point of score. */
const AREA_PER_POINT = 10_000;

/** How far apart the shelves sit in the stack, in millimetres. */
const SHELF_PITCH_MM = 180;

/** Millimetres of stack height worth one point of score. */
const HEIGHT_PER_POINT = 60;

/** How much of the bucket bisque ware draws, against a plain greenware slot. */
const BISQUE_DRAW = 1.25;

/** How much greenware draws, which is less: an unfired body is still closing up. */
const GREENWARE_DRAW = 0.8;

/** The cone a rack is taken to before any of its score is counted. */
const BASELINE_CONE = 4;

/** Points of score worth one further cone of heat work. */
const CONE_STEP = 12;

/** Minutes of extra soak a rack earns for each slot loaded into it. */
const SOAK_PER_SLOT = 2;

/** The longest extra soak a deep rack earns, in minutes. */
const EXTRA_SOAK_CEILING = 12;

/** One slot of a kiln shelf, as the loading sheet records it. */
interface ShelfSlot {
  /** How the slot is labelled on the loading sheet. */
  label: string;
  /** Usable width of the slot, in millimetres. */
  widthMm: number;
  /** Clearance from the shelf to the one above it, in millimetres. */
  heightMm: number;
  /** Whether the slot holds bisque ware; greenware when it does not. */
  bisque: boolean;
}

/** A rack of slots loaded into one kiln for a single firing. */
interface ShelfLoad {
  /** The kiln the rack was loaded into. */
  kilnId: string;
  /** The slots in loading order, lowest shelf first. */
  slots: ShelfSlot[];
}

/** A glaze in the studio's book, with the firing it asks for. */
interface GlazeProfile {
  /** The studio's code for the glaze, as it is written on the bucket. */
  code: string;
  /** The cone the glaze matures at. */
  coneValue: number;
  /** How long to hold the peak once the cone is down, in minutes. */
  soakMinutes: number;
}

/**
 * The glazes the studio keeps mixed, coolest first.
 *
 * Read-only, and only ever read: choosing a glaze for a rack never changes the
 * book the choice was made from.
 */
const GLAZE_PROFILES: readonly GlazeProfile[] = [
  { code: 'MATTE-04', coneValue: 4, soakMinutes: 12 },
  { code: 'CELADON-06', coneValue: 6, soakMinutes: 18 },
  { code: 'TENMOKU-08', coneValue: 8, soakMinutes: 24 },
];

/**
 * The house stoneware glaze, at the top of the kiln's range.
 *
 * It is where a heavy rack lands. Nothing in the book is hotter, so a rack
 * asking for more heat work than the book covers is fired on this one.
 */
const HOUSE_GLAZE: GlazeProfile = { code: 'SHINO-10', coneValue: 10, soakMinutes: 30 };

/**
 * How much heat work one slot asks for, as a whole number of points.
 *
 * The footprint is the piece's share of the bucket, scaled by what its body
 * draws, and the index is the slot's place in the stack: shelves are written
 * down lowest first, so a higher index sits nearer the top elements and costs
 * more points.
 *
 * @param slot The slot, as the loading sheet records it.
 * @param index The slot's place in the loading order, counting from zero.
 * @returns The slot's score, in points.
 */
export const scoreShelfSlot = (slot: ShelfSlot, index: number): number => {
  const footprint = (slot.widthMm * slot.heightMm) / AREA_PER_POINT;
  const draw = slot.bisque ? BISQUE_DRAW : GREENWARE_DRAW;
  const height = (index * SHELF_PITCH_MM) / HEIGHT_PER_POINT;

  return Math.round(footprint * draw + height);
};

/**
 * The glaze to fire a loaded rack on.
 *
 * Every slot is scored, and two readings come out of those scores: the busiest
 * slot, which sets how much heat work the rack asks for, and the rack's
 * average, which keeps one large piece among small ones from deciding the whole
 * firing. The coolest glaze in the book that still carries that much heat work
 * wins, and the house glaze carries a rack the book cannot.
 *
 * The soak is lengthened by how deep the rack is, because the middle shelves of
 * a full kiln reach the peak last and need the hold to even out.
 *
 * @param load The rack as it was loaded.
 * @returns A fresh entry: the chosen glaze's code and cone, with the soak this
 * rack needs.
 */
export const pickGlazeProfile = (load: ShelfLoad): GlazeProfile => {
  const scores = load.slots.map(scoreShelfSlot);

  let busiest = 0;
  let total = 0;

  for (const score of scores) {
    total += score;

    if (score > busiest) {
      busiest = score;
    }
  }

  const loaded = scores.length;
  const average = loaded === 0 ? 0 : total / loaded;
  const target = BASELINE_CONE + Math.round((busiest + average) / CONE_STEP);

  let chosen = HOUSE_GLAZE;

  for (const profile of GLAZE_PROFILES) {
    if (profile.coneValue >= target && profile.coneValue < chosen.coneValue) {
      chosen = profile;
    }
  }

  return {
    code: chosen.code,
    coneValue: chosen.coneValue,
    soakMinutes: chosen.soakMinutes + Math.min(loaded * SOAK_PER_SLOT, EXTRA_SOAK_CEILING),
  };
};
