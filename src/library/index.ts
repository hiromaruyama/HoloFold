/**
 * Hand-authored models in the same format Claude produces, so the AR guide works with
 * no API key. Coordinates are exact geometry (22.5° kite creases, etc.), normalized to
 * each step's outline bounding box; `aspect` restores proportions.
 */
import type { FoldLine, GuidePlan, Point, Step } from "../../shared/schema";

const P = (x: number, y: number): Point => ({ x, y });
const line = (a: "V" | "M" | "F", x1: number, y1: number, x2: number, y2: number, flap?: [number, number]): FoldLine => ({
  from: P(x1, y1),
  to: P(x2, y2),
  assignment: a,
  flap: flap ? P(flap[0], flap[1]) : null,
});
const V = (x1: number, y1: number, x2: number, y2: number, flap?: [number, number]) => line("V", x1, y1, x2, y2, flap);
const M = (x1: number, y1: number, x2: number, y2: number, flap?: [number, number]) => line("M", x1, y1, x2, y2, flap);
const poly = (...xy: number[]): Point[] => {
  const out: Point[] = [];
  for (let i = 0; i < xy.length; i += 2) out.push(P(xy[i], xy[i + 1]));
  return out;
};

type StepInput = Pick<Step, "title" | "instruction" | "action" | "shape"> & Partial<Step>;
const step = (s: StepInput): Step => ({
  aspect: 1,
  lines: [],
  rotateDegrees: null,
  tip: "",
  source: null,
  ...s,
});

const SQUARE = poly(0, 0, 1, 0, 1, 1, 0, 1);
const DIAMOND = poly(0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5);
// Bird base: a rhombus whose width ÷ height is tan 22.5° = √2 − 1.
const BIRD_ASPECT = Math.SQRT2 - 1;
// Where the 22.5° kite creases from the bottom corner meet the square base's upper edges.
const k = 0.2071;
const kr = 1 - k;

const crane: GuidePlan = {
  id: "lib-crane",
  origin: "library",
  createdAt: 0,
  accent: "#38f9ff",
  isOrigami: true,
  title: "Classic Crane",
  summary: "The traditional orizuru: a bird base turned into a crane with a head, tail and wings.",
  difficulty: "medium",
  sheets: 1,
  paper: "One square, 15 cm or larger, colored on one side",
  notes: "",
  steps: [
    step({
      title: "Crease the book folds",
      instruction: "Start colored side up. Fold in half edge to edge, crease, and unfold. Repeat in the other direction.",
      action: "crease-unfold",
      shape: SQUARE,
      lines: [V(0, 0.5, 1, 0.5, [0.5, 0.85]), V(0.5, 0, 0.5, 1, [0.85, 0.5])],
      tip: "Crease sharply with a fingernail — every later fold relies on these lines.",
    }),
    step({
      title: "Turn over",
      instruction: "Turn the paper over so the white side faces up.",
      action: "turn-over",
      shape: SQUARE,
    }),
    step({
      title: "Crease the diagonals",
      instruction: "Fold corner to corner along both diagonals, crease, and unfold.",
      action: "crease-unfold",
      shape: SQUARE,
      lines: [V(0, 0, 1, 1, [0.2, 0.8]), V(1, 0, 0, 1, [0.8, 0.8])],
    }),
    step({
      title: "Collapse into a Square Base",
      instruction:
        "Turn the paper so a corner points at you. Bring the left, right and top corners down to the bottom corner along the creases, and flatten into a small square.",
      action: "collapse",
      shape: DIAMOND,
      lines: [V(0.5, 0, 0.5, 1), V(0, 0.5, 1, 0.5), M(0.25, 0.25, 0.75, 0.75), M(0.75, 0.25, 0.25, 0.75)],
      tip: "Push the side corners in toward each other and the paper will collapse on its own.",
    }),
    step({
      title: "Kite fold the top layer",
      instruction: "With the open end pointing at you, fold the lower left and right edges of the top layer to the center line.",
      action: "valley",
      shape: DIAMOND,
      lines: [V(0.5, 1, k, 0.2929, [0.12, 0.5]), V(0.5, 1, kr, 0.2929, [0.88, 0.5])],
      tip: "Top layer only. The two edges should meet exactly on the center line.",
    }),
    step({
      title: "Crease the top triangle",
      instruction: "Fold the top triangle down over the kite flaps and crease hard. Then unfold the triangle and both kite flaps.",
      action: "crease-unfold",
      shape: DIAMOND,
      lines: [V(k, 0.2929, kr, 0.2929, [0.5, 0.12])],
    }),
    step({
      title: "Petal fold",
      instruction:
        "Lift the bottom corner of the top layer up along the horizontal crease. Let the sides fold inward on the kite creases and press flat into a long diamond.",
      action: "petal",
      shape: DIAMOND,
      lines: [V(k, 0.2929, kr, 0.2929, [0.5, 0.85]), M(0.5, 1, k, 0.2929), M(0.5, 1, kr, 0.2929)],
      tip: "Go slowly: the side edges meet at the center as you flatten.",
    }),
    step({
      title: "Turn over and kite fold",
      instruction: "Turn the model over. Fold the lower edges of this side's top layer to the center line, like before.",
      action: "valley",
      shape: poly(0.5, 0, kr, 0.5, 1, 0.6464, 0.5, 1, 0, 0.6464, k, 0.5),
      aspect: Math.SQRT1_2,
      lines: [V(0.5, 1, k, 0.5, [0.1, 0.64]), V(0.5, 1, kr, 0.5, [0.9, 0.64])],
    }),
    step({
      title: "Petal fold the back — Bird Base",
      instruction:
        "Fold the top triangle down and unfold to crease it, open the kite flaps, then petal fold this side too. This is the Bird Base.",
      action: "petal",
      shape: DIAMOND,
      aspect: BIRD_ASPECT,
      lines: [V(0, 0.5, 1, 0.5, [0.5, 0.85]), M(0.5, 1, 0, 0.5), M(0.5, 1, 1, 0.5)],
    }),
    step({
      title: "Narrow the legs",
      instruction: "With the split end pointing at you, fold the lower edges of the top layer to the center line.",
      action: "valley",
      shape: DIAMOND,
      aspect: BIRD_ASPECT,
      lines: [V(0.5, 1, 0.1756, 0.3246, [0.08, 0.5]), V(0.5, 1, 0.8244, 0.3246, [0.92, 0.5])],
      tip: "The two loose legs belong at the bottom; the wing flaps point up.",
    }),
    step({
      title: "Narrow the other side",
      instruction: "Turn over and repeat: fold the lower edges to the center line.",
      action: "valley",
      shape: DIAMOND,
      aspect: BIRD_ASPECT,
      lines: [V(0.5, 1, 0.1756, 0.3246, [0.08, 0.5]), V(0.5, 1, 0.8244, 0.3246, [0.92, 0.5])],
    }),
    step({
      title: "Reverse fold the neck and tail",
      instruction:
        "Inside reverse fold each thin bottom point up between the wing layers so it sticks out at an angle. One becomes the neck, the other the tail.",
      action: "inside-reverse",
      shape: poly(0.5, 0, 1, 0.3246, 0.5, 1, 0, 0.3246),
      aspect: 0.2686,
      lines: [V(0.1, 0.46, 0.5, 0.4, [0.35, 0.8]), V(0.9, 0.46, 0.5, 0.4, [0.65, 0.8])],
      tip: "Crease each point first as a valley fold both ways, then open the layers and push it up inside.",
    }),
    step({
      title: "Form the head",
      instruction: "Inside reverse fold the tip of one point down to make the head.",
      action: "inside-reverse",
      shape: poly(0, 0.15, 0.5, 0, 1, 0.15, 0.5, 1),
      aspect: 1.2,
      lines: [V(0.029, 0.28, 0.091, 0.23, [0.01, 0.17])],
    }),
    step({
      title: "Fold the wings down",
      instruction: "Fold both wings down, one in front and one behind, so they stick out to the sides.",
      action: "valley",
      shape: poly(0, 0.15, 0.5, 0, 1, 0.15, 0.5, 1),
      aspect: 1.2,
      lines: [V(0.36, 0.6, 0.64, 0.6, [0.5, 0.25]), M(0.36, 0.62, 0.64, 0.62)],
    }),
    step({
      title: "Shape your crane",
      instruction: "Hold the base of the neck and tail and gently pull the wings apart to puff out the body. Your crane is finished!",
      action: "shape",
      shape: poly(0, 0.15, 0.5, 0, 1, 0.15, 0.5, 1),
      aspect: 1.2,
      tip: "Fold 1,000 and legend says you get a wish.",
    }),
  ],
};

const shuriken: GuidePlan = {
  id: "lib-shuriken",
  origin: "library",
  createdAt: 0,
  accent: "#ff4fd8",
  isOrigami: true,
  title: "Ninja Star",
  summary: "A two-piece shuriken: two folded strips that lock together into a four-point star.",
  difficulty: "easy",
  sheets: 2,
  paper: "Two squares of the same size, ideally contrasting colors",
  notes: "",
  steps: [
    step({
      title: "Crease the center",
      instruction: "Take sheet A. Fold it in half lengthwise, crease, and unfold.",
      action: "crease-unfold",
      shape: SQUARE,
      lines: [V(0.5, 0, 0.5, 1, [0.85, 0.5])],
      tip: "Two sheets in contrasting colors make the finished star pop.",
    }),
    step({
      title: "Edges to the center",
      instruction: "Fold both side edges in to meet the center crease.",
      action: "valley",
      shape: SQUARE,
      lines: [V(0.25, 0, 0.25, 1, [0.1, 0.5]), V(0.75, 0, 0.75, 1, [0.9, 0.5])],
    }),
    step({
      title: "Fold into a strip",
      instruction: "Fold in half along the center so you have a long, thin strip.",
      action: "valley",
      shape: SQUARE,
      aspect: 0.5,
      lines: [V(0.5, 0, 0.5, 1, [0.85, 0.5])],
    }),
    step({
      title: "Mark the middle",
      instruction: "Fold the strip in half crosswise, crease, and unfold to mark its middle.",
      action: "crease-unfold",
      shape: SQUARE,
      aspect: 0.25,
      lines: [V(0, 0.5, 1, 0.5, [0.5, 0.85])],
    }),
    step({
      title: "Fold the ends into triangles",
      instruction: "Fold the top-left corner down to the right edge, and the bottom-right corner up to the left edge.",
      action: "valley",
      shape: SQUARE,
      aspect: 0.25,
      lines: [V(1, 0, 0, 0.25, [0.2, 0.05]), V(0, 1, 1, 0.75, [0.8, 0.95])],
      tip: "The triangles go in opposite directions, making a Z.",
    }),
    step({
      title: "Make the points",
      instruction:
        "Fold the top end down along the diagonal so it sticks out to the left, and the bottom end up so it sticks out to the right.",
      action: "valley",
      shape: poly(1, 0, 1, 0.75, 0, 1, 0, 0.25),
      aspect: 0.25,
      lines: [V(1, 0.25, 0, 0.5, [0.5, 0.12]), V(0, 0.75, 1, 0.5, [0.5, 0.88])],
    }),
    step({
      title: "Fold sheet B (mirrored)",
      instruction: "Repeat everything with sheet B, but make the triangle and point folds as a mirror image so its points face the other way.",
      action: "repeat",
      shape: SQUARE,
      tip: "If both pieces look identical when side by side, one of them needs flipping.",
    }),
    step({
      title: "Cross the pieces",
      instruction: "Turn piece A over and lay piece B across its middle to form a plus sign.",
      action: "other",
      shape: SQUARE,
    }),
    step({
      title: "Lock the first two points",
      instruction: "Fold piece A's two points across piece B and tuck each one into B's open pockets.",
      action: "tuck",
      shape: SQUARE,
      lines: [V(0.33, 0.33, 0.67, 0.33, [0.5, 0.1]), V(0.33, 0.67, 0.67, 0.67, [0.5, 0.9])],
    }),
    step({
      title: "Lock the last two points",
      instruction: "Flip the star over. Fold the remaining two points in and tuck them into the pockets.",
      action: "tuck",
      shape: SQUARE,
      lines: [V(0.33, 0.33, 0.33, 0.67, [0.1, 0.5]), V(0.67, 0.33, 0.67, 0.67, [0.9, 0.5])],
    }),
    step({
      title: "Star complete",
      instruction: "Press everything flat. Your ninja star is done — throw it gently, never at people or animals.",
      action: "shape",
      shape: poly(0.5, 0, 0.65, 0.35, 1, 0.5, 0.65, 0.65, 0.5, 1, 0.35, 0.65, 0, 0.5, 0.35, 0.35),
    }),
  ],
};

const PLANE_ASPECT = 0.74; // Letter/A4 held portrait
const plane: GuidePlan = {
  id: "lib-plane",
  origin: "library",
  createdAt: 0,
  accent: "#ffc04d",
  isOrigami: true,
  title: "Paper Plane",
  summary: "The classic dart: a fast, straight flyer from one rectangular sheet.",
  difficulty: "easy",
  sheets: 1,
  paper: "One sheet of Letter or A4 paper",
  notes: "",
  steps: [
    step({
      title: "Crease the center",
      instruction: "Hold the paper tall. Fold it in half lengthwise, crease, and unfold.",
      action: "crease-unfold",
      shape: SQUARE,
      aspect: PLANE_ASPECT,
      lines: [V(0.5, 0, 0.5, 1, [0.85, 0.5])],
    }),
    step({
      title: "Fold the top corners in",
      instruction: "Fold both top corners down so their edges meet on the center crease.",
      action: "valley",
      shape: SQUARE,
      aspect: PLANE_ASPECT,
      lines: [V(0.5, 0, 0, 0.37, [0.1, 0.06]), V(0.5, 0, 1, 0.37, [0.9, 0.06])],
    }),
    step({
      title: "Fold the edges in again",
      instruction: "Fold the new slanted edges to the center crease, making a sharper point.",
      action: "valley",
      shape: poly(0.5, 0, 1, 0.37, 1, 1, 0, 1, 0, 0.37),
      aspect: PLANE_ASPECT,
      lines: [V(0.5, 0, 0, 0.893, [0.08, 0.6]), V(0.5, 0, 1, 0.893, [0.92, 0.6])],
    }),
    step({
      title: "Fold in half",
      instruction: "Fold the plane in half along the center crease, with the folded flaps on the outside.",
      action: "mountain",
      shape: poly(0.5, 0, 1, 0.893, 1, 1, 0, 1, 0, 0.893),
      aspect: PLANE_ASPECT,
      lines: [M(0.5, 0, 0.5, 1, [0.15, 0.8])],
    }),
    step({
      title: "Fold the wings down",
      instruction: "Fold the top wing down so its slanted edge lines up with the spine. Turn over and do the same on the other side.",
      action: "valley",
      shape: poly(0, 0, 1, 0.893, 1, 1, 0, 1),
      aspect: 0.37,
      lines: [V(0, 0, 0.537, 1, [0.8, 0.9])],
      tip: "Both wings should match exactly or the plane will curve.",
    }),
    step({
      title: "Ready for takeoff",
      instruction: "Lift the wings so they sit flat and level. Hold underneath near the front and throw gently and straight.",
      action: "shape",
      shape: poly(0.5, 0, 1, 1, 0, 1),
      aspect: 0.8,
    }),
  ],
};

const cup: GuidePlan = {
  id: "lib-cup",
  origin: "library",
  createdAt: 0,
  accent: "#5dffb0",
  isOrigami: true,
  title: "Paper Cup",
  summary: "A five-fold cup that really holds water for a minute. A great first model for testing the tracker.",
  difficulty: "easy",
  sheets: 1,
  paper: "One square, 15 cm or larger",
  notes: "",
  steps: [
    step({
      title: "Fold into a triangle",
      instruction: "Hold the square as a diamond. Fold the bottom corner up to the top corner.",
      action: "valley",
      shape: DIAMOND,
      lines: [V(0, 0.5, 1, 0.5, [0.5, 0.85])],
    }),
    step({
      title: "Right corner across",
      instruction: "Fold the right corner over to touch the left edge, keeping the top of the flap level.",
      action: "valley",
      shape: poly(0.5, 0, 1, 1, 0, 1),
      aspect: 2,
      lines: [V(0.5858, 1, 0.7071, 0.4142, [0.9, 0.93])],
    }),
    step({
      title: "Left corner across",
      instruction: "Fold the left corner over to touch the right edge, at the same height.",
      action: "valley",
      shape: poly(0.7071, 0, 1, 0.4142, 0.8284, 1, 0, 1),
      aspect: Math.SQRT2,
      lines: [V(0.5858, 1, 0.4142, 0.4142, [0.08, 0.95])],
    }),
    step({
      title: "Fold the top flaps down",
      instruction: "Fold the front top flap down over the front, then fold the back flap down behind.",
      action: "valley",
      shape: poly(0.5, 0, 1, 0.5, 0.7071, 1, 0.2929, 1, 0, 0.5),
      aspect: 0.8284,
      lines: [V(0, 0.5, 1, 0.5, [0.5, 0.2]), M(0.02, 0.52, 0.98, 0.52)],
      tip: "Tuck the front flap into the pocket for a sturdier cup.",
    }),
    step({
      title: "Open the cup",
      instruction: "Gently squeeze the sides to open the cup. Done!",
      action: "shape",
      shape: poly(0, 0, 1, 0, 0.7071, 1, 0.2929, 1),
      aspect: 1.657,
    }),
  ],
};

const fortune: GuidePlan = {
  id: "lib-fortune",
  origin: "library",
  createdAt: 0,
  accent: "#c4a8ff",
  isOrigami: true,
  title: "Fortune Teller",
  summary: "The playground classic: four pockets that open and close on your fingers.",
  difficulty: "easy",
  sheets: 1,
  paper: "One square, 15 cm or larger",
  notes: "",
  steps: [
    step({
      title: "Crease the diagonals",
      instruction: "Fold corner to corner along both diagonals, crease, and unfold.",
      action: "crease-unfold",
      shape: SQUARE,
      lines: [V(0, 0, 1, 1, [0.2, 0.8]), V(1, 0, 0, 1, [0.8, 0.8])],
    }),
    step({
      title: "Corners to the center",
      instruction: "Fold all four corners in so their points meet exactly at the center.",
      action: "valley",
      shape: SQUARE,
      lines: [
        V(0.5, 0, 1, 0.5, [0.9, 0.1]),
        V(1, 0.5, 0.5, 1, [0.9, 0.9]),
        V(0.5, 1, 0, 0.5, [0.1, 0.9]),
        V(0, 0.5, 0.5, 0, [0.1, 0.1]),
      ],
      tip: "Line each point up with the crossing of the diagonal creases.",
    }),
    step({
      title: "Turn over",
      instruction: "Turn the paper over so the smooth side faces up.",
      action: "turn-over",
      shape: DIAMOND,
    }),
    step({
      title: "Corners to the center again",
      instruction: "Fold the four new corners in to the center, just like before.",
      action: "valley",
      shape: DIAMOND,
      lines: [
        V(0.25, 0.25, 0.75, 0.25, [0.5, 0.08]),
        V(0.75, 0.25, 0.75, 0.75, [0.92, 0.5]),
        V(0.75, 0.75, 0.25, 0.75, [0.5, 0.92]),
        V(0.25, 0.75, 0.25, 0.25, [0.08, 0.5]),
      ],
    }),
    step({
      title: "Crease in half both ways",
      instruction: "Fold the square in half edge to edge, crease, and unfold. Repeat in the other direction.",
      action: "crease-unfold",
      shape: SQUARE,
      lines: [V(0, 0.5, 1, 0.5, [0.5, 0.15]), V(0.5, 0, 0.5, 1, [0.15, 0.5])],
    }),
    step({
      title: "Open the pockets",
      instruction:
        "Slide your thumbs and index fingers under the four square flaps on the back, then push the corners together so the four points rise up.",
      action: "shape",
      shape: SQUARE,
      tip: "Pinch the points together and apart to open the fortune teller one way, then the other.",
    }),
  ],
};

export const LIBRARY: GuidePlan[] = [crane, shuriken, plane, cup, fortune];
