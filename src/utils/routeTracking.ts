import { getDistanceKm, distanceToTimeMinutes } from '../services/waypointOptimizer';

export interface RouteProgressStats {
  remainingDistanceKm: number;
  remainingTimeMinutes: number;
}

/** Cumulative path distance between point indices (inclusive start, exclusive end segment pairs) */
export function calculatePathDistanceKm(
  routePoints: [number, number][],
  fromIdx: number,
  toIdx: number
): number {
  if (routePoints.length < 2 || fromIdx >= toIdx) return 0;

  const start = Math.max(0, fromIdx);
  const end = Math.min(routePoints.length - 1, toIdx);
  let total = 0;

  for (let i = start; i < end; i++) {
    const p1 = routePoints[i];
    const p2 = routePoints[i + 1];
    total += getDistanceKm([p1[1], p1[0]], [p2[1], p2[0]]);
  }

  return total;
}

/** Remaining distance/time from current progress along the route */
export function calculateRemainingRouteStats(
  route: {
    points: [number, number][];
    steps?: { distanceMeters: number; durationSeconds: number }[];
    distanceKm: number;
    estimatedTimeMinutes: number;
  },
  progressIndex: number,
  stepIndex?: number,
  traveledKm?: number,
  totalRouteKm?: number
): RouteProgressStats {
  if (route.steps?.length && stepIndex !== undefined) {
    let distanceMeters = 0;
    let durationSeconds = 0;
    for (let i = stepIndex; i < route.steps.length; i++) {
      distanceMeters += route.steps[i].distanceMeters;
      durationSeconds += route.steps[i].durationSeconds;
    }
    return {
      remainingDistanceKm: parseFloat((distanceMeters / 1000).toFixed(2)),
      remainingTimeMinutes: Math.max(0, Math.round(durationSeconds / 60)),
    };
  }

  let remainingDistanceKm: number;
  if (traveledKm !== undefined && totalRouteKm !== undefined && totalRouteKm > 0) {
    remainingDistanceKm = Math.max(0, totalRouteKm - traveledKm);
  } else {
    remainingDistanceKm = calculatePathDistanceKm(
      route.points,
      progressIndex,
      route.points.length - 1
    );
  }

  const remainingTimeMinutes =
    route.distanceKm > 0
      ? Math.max(0, Math.round(route.estimatedTimeMinutes * (remainingDistanceKm / route.distanceKm)))
      : distanceToTimeMinutes(remainingDistanceKm);

  return {
    remainingDistanceKm: parseFloat(remainingDistanceKm.toFixed(2)),
    remainingTimeMinutes,
  };
}

export function formatRemainingRouteSummary(stats: RouteProgressStats): string {
  if (stats.remainingDistanceKm < 0.05) {
    return 'Майже на місці';
  }
  return `${stats.remainingDistanceKm} км · ~${stats.remainingTimeMinutes} хв залишилось`;
}

export interface RouteProgressPosition {
  segmentIndex: number;
  snappedPoint: [number, number];
  distanceFromRouteKm: number;
  traveledKm: number;
}

const LOOP_ENDPOINT_THRESHOLD_KM = 0.15;
const PROGRESS_LOOKAHEAD_KM = 0.45;
const PROGRESS_BACKTRACK_KM = 0.08;

/** True when route start and end are near each other (circular / exploration route). */
export function isLoopRoute(routePoints: [number, number][]): boolean {
  if (routePoints.length < 2) return false;
  const start = routePoints[0];
  const end = routePoints[routePoints.length - 1];
  return getDistanceKm([start[1], start[0]], [end[1], end[0]]) < LOOP_ENDPOINT_THRESHOLD_KM;
}

/** Cumulative distance from route start to each point index. */
export function buildCumulativeDistancesKm(routePoints: [number, number][]): number[] {
  const cumulative = [0];
  for (let i = 1; i < routePoints.length; i++) {
    const prev = routePoints[i - 1];
    const curr = routePoints[i];
    cumulative.push(
      cumulative[i - 1] + getDistanceKm([prev[1], prev[0]], [curr[1], curr[0]])
    );
  }
  return cumulative;
}

export function getTraveledKmAtPosition(
  routePoints: [number, number][],
  cumulativeKm: number[],
  segmentIndex: number,
  snappedPoint: [number, number]
): number {
  const base = cumulativeKm[segmentIndex] ?? 0;
  const next = cumulativeKm[Math.min(segmentIndex + 1, routePoints.length - 1)] ?? base;
  const segLen = next - base;
  if (segLen <= 0) return base;

  const alongSegKm = getDistanceKm(
    [routePoints[segmentIndex][1], routePoints[segmentIndex][0]],
    [snappedPoint[1], snappedPoint[0]]
  );
  return base + Math.min(segLen, alongSegKm);
}

function projectPointOntoSegment(
  userLngLat: [number, number],
  aLatLng: [number, number],
  bLatLng: [number, number]
): { distKm: number; t: number; point: [number, number] } {
  const [uLng, uLat] = userLngLat;
  const [aLat, aLng] = aLatLng;
  const [bLat, bLng] = bLatLng;

  const dx = bLng - aLng;
  const dy = bLat - aLat;
  const len2 = dx * dx + dy * dy;

  if (len2 === 0) {
    return {
      distKm: getDistanceKm(userLngLat, [aLng, aLat]),
      t: 0,
      point: aLatLng,
    };
  }

  const t = Math.max(0, Math.min(1, ((uLng - aLng) * dx + (uLat - aLat) * dy) / len2));
  const pLat = aLat + t * dy;
  const pLng = aLng + t * dx;

  return {
    distKm: getDistanceKm(userLngLat, [pLng, pLat]),
    t,
    point: [pLat, pLng],
  };
}

function searchRouteSegments(
  routePoints: [number, number][],
  userLngLat: [number, number],
  searchStart: number,
  searchEnd: number,
  cumulativeKm: number[] | undefined,
  minTraveledKm: number,
  useDistanceWindow: boolean
): Omit<RouteProgressPosition, 'traveledKm'> | null {
  let bestDist = Infinity;
  let bestSegmentIndex = searchStart;
  let bestSnap: [number, number] = routePoints[searchStart];
  let bestT = 0;
  let found = false;

  const minAllowedKm = Math.max(0, minTraveledKm - PROGRESS_BACKTRACK_KM);
  const maxAllowedKm = minTraveledKm + PROGRESS_LOOKAHEAD_KM;

  for (let i = searchStart; i <= searchEnd; i++) {
    if (useDistanceWindow && cumulativeKm) {
      const segKm = cumulativeKm[i] ?? 0;
      if (segKm < minAllowedKm || segKm > maxAllowedKm) continue;
    }

    const proj = projectPointOntoSegment(userLngLat, routePoints[i], routePoints[i + 1]);
    if (proj.distKm < bestDist) {
      bestDist = proj.distKm;
      bestSegmentIndex = i;
      bestSnap = proj.point;
      bestT = proj.t;
      found = true;
    }
  }

  if (!found) return null;

  const segmentIndex =
    bestT > 0.85
      ? Math.min(bestSegmentIndex + 1, routePoints.length - 1)
      : bestSegmentIndex;

  return {
    segmentIndex,
    snappedPoint: bestSnap,
    distanceFromRouteKm: bestDist,
  };
}

/**
 * Project user onto route polyline.
 * For loop routes, uses cumulative distance so the closing leg is not matched at the start.
 */
export function findRouteProgress(
  routePoints: [number, number][],
  userLngLat: [number, number],
  minSegmentIndex = 0,
  minTraveledKm = 0,
  cumulativeKm?: number[]
): RouteProgressPosition {
  if (routePoints.length === 0) {
    return { segmentIndex: 0, snappedPoint: [0, 0], distanceFromRouteKm: Infinity, traveledKm: 0 };
  }
  if (routePoints.length === 1) {
    return {
      segmentIndex: 0,
      snappedPoint: routePoints[0],
      distanceFromRouteKm: getDistanceKm(userLngLat, [routePoints[0][1], routePoints[0][0]]),
      traveledKm: 0,
    };
  }

  const cum = cumulativeKm ?? buildCumulativeDistancesKm(routePoints);
  const isLoop = isLoopRoute(routePoints);
  const searchStart = Math.max(0, minSegmentIndex);
  const searchEnd = Math.min(routePoints.length - 2, searchStart + 200);

  let match = searchRouteSegments(
    routePoints,
    userLngLat,
    searchStart,
    searchEnd,
    cum,
    minTraveledKm,
    isLoop
  );

  if (!match && isLoop) {
    match = searchRouteSegments(
      routePoints,
      userLngLat,
      searchStart,
      searchEnd,
      cum,
      minTraveledKm,
      false
    );
  }

  if (!match) {
    return {
      segmentIndex: minSegmentIndex,
      snappedPoint: routePoints[minSegmentIndex],
      distanceFromRouteKm: Infinity,
      traveledKm: minTraveledKm,
    };
  }

  const traveledKm = getTraveledKmAtPosition(
    routePoints,
    cum,
    match.segmentIndex,
    match.snappedPoint
  );

  return { ...match, traveledKm };
}

/** Find index of closest vertex on route to user position */
export function findClosestPointIndex(
  routePoints: [number, number][],
  userLngLat: [number, number]
): number {
  return findRouteProgress(routePoints, userLngLat, 0).segmentIndex;
}

export function getStepRemainingToEnd(
  step: { distanceMeters: number; durationSeconds: number; endLocation: [number, number] },
  userLngLat: [number, number]
): { distanceMeters: number; durationSeconds: number } {
  const distKm = getDistanceKm(userLngLat, [step.endLocation[1], step.endLocation[0]]);
  const distanceMeters = Math.min(
    step.distanceMeters,
    Math.max(0, Math.round(distKm * 1000))
  );
  const durationSeconds =
    step.distanceMeters > 0
      ? Math.max(0, Math.round(step.durationSeconds * (distanceMeters / step.distanceMeters)))
      : 0;

  return { distanceMeters, durationSeconds };
}

/** Find current step index based on proximity to step end points and route progress */
export function findCurrentStepIndex(
  steps: { endLocation: [number, number] }[],
  userLatLng: [number, number],
  routeProgressIndex: number,
  totalRoutePoints: number,
  isLoop = false
): number {
  if (steps.length === 0) return 0;

  const userLngLat: [number, number] = [userLatLng[1], userLatLng[0]];
  const progressRatio = routeProgressIndex / Math.max(1, totalRoutePoints - 1);
  const stepFromProgress = Math.min(
    Math.floor(progressRatio * steps.length),
    steps.length - 1
  );

  if (isLoop) {
    let bestIdx = stepFromProgress;
    for (let i = stepFromProgress; i < steps.length; i++) {
      const stepEnd = steps[i].endLocation;
      const dist = getDistanceKm(userLngLat, [stepEnd[1], stepEnd[0]]);
      if (dist < 0.04) {
        bestIdx = Math.min(i + 1, steps.length - 1);
      }
    }
    return bestIdx;
  }

  let bestIdx = 0;
  for (let i = 0; i < steps.length; i++) {
    const stepEnd = steps[i].endLocation;
    const dist = getDistanceKm(userLngLat, [stepEnd[1], stepEnd[0]]);
    if (dist < 0.04) {
      bestIdx = Math.min(i + 1, steps.length - 1);
    }
  }

  return Math.max(bestIdx, Math.min(stepFromProgress, steps.length - 1));
}

export function stripHtml(html: string): string {
  if (typeof document === 'undefined') return html.replace(/<[^>]*>/g, '');
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent?.trim() || '';
}
