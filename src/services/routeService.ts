/// <reference types="google.maps" />

import {
  getDistanceKm, timeToDistanceKm, scorePlaceOnPath, pickBestRatedPlace,
} from './waypointOptimizer';
import { geocodeAddress } from './placesService';
import { stripHtml } from '../utils/routeTracking';
import { calculateElevationProfile, getTerrainInfo, calculateRouteDifficulty } from './routeOptions';
import type { RouteDifficulty, ElevationProfile } from '../types/routeEnhancements';

// ─── Interfaces & Types ─────────────────────────────────────────────────────────

export interface Place {
  name: string;
  coordinates: [number, number]; // [lng, lat]
  type: string;
  address?: string;
  rating?: number;
  userRatingsTotal?: number;
  photoUrl?: string;
  description?: string;
  source?: 'google' | 'custom';
  externalId?: string;
}

export type PoiCategory =
  | 'cafe' | 'park' | 'shop' | 'restaurant' | 'museum'
  | 'library' | 'place_of_worship' | 'beach' | 'lake' | 'river' | 'custom' | 'tourist_attraction';

export interface RouteWaypoint {
  location: [number, number]; // [lat, lng]
  name: string;
  type: PoiCategory;
  address?: string;
  rating?: number;
  userRatingsTotal?: number;
  photoUrl?: string;
  description?: string;
  source?: 'google' | 'custom';
  externalId?: string;
}

export interface RouteStep {
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
  endLocation: [number, number]; // [lat, lng]
  maneuver?: string;
}

export interface RouteResult {
  points: [number, number][]; // [lat, lng]
  waypoints: RouteWaypoint[];
  steps?: RouteStep[];
  distanceKm: number;
  estimatedTimeMinutes: number;
  locations: string[];
  difficulty?: RouteDifficulty;
  elevation?: ElevationProfile;
  terrainTypes?: string[];
  name?: string;
  description?: string;
  preferences?: any;
}

export interface RouteDestination {
  coords?: [number, number]; // [lng, lat]
  address?: string;
  name?: string;
}

export interface RouteFilterOptions {
  routeMode: "exploration" | "point_to_point";
  categories: string[];
  targetTimeMinutes: number;
  destination?: RouteDestination;
}

const EXTENDED_POI_TYPES = [
  'cafe', 'park', 'restaurant', 'store', 'museum', 'library', 
  'tourist_attraction', 'point_of_interest', 'church', 'natural_feature'
];

export const PLACE_TYPE_MAPPING: Record<string, string> = {
  'парк': 'park',
  'парки': 'park',
  'кав\'ярня': 'cafe',
  'кав\'ярні': 'cafe',
  'кафе': 'cafe',
  'ресторан': 'restaurant',
  'ресторани': 'restaurant',
  'пекарня': 'bakery',
  'пекарні': 'bakery',
  'музей': 'museum',
  'музеї': 'museum',
  'галерея': 'art_gallery',
  'галереї': 'art_gallery',
  'бібліотека': 'library',
  'бібліотеки': 'library',
  'книгарня': 'book_store',
  'книгарні': 'book_store',
  'церква': 'church',
  'храм': 'church',
  'храми': 'church',
  'визначне місце': 'tourist_attraction',
  'визначні місця': 'tourist_attraction',
  'пам\'ятка': 'tourist_attraction',
  'магазин': 'store',
  'магазини': 'store',
  'торговий центр': 'shopping_mall',
  'тц': 'shopping_mall',
  'спортзал': 'gym',
  'зал': 'gym',
  'спа': 'spa',
  'зоопарк': 'zoo',
  'стадіон': 'stadium',
  'кінотеатр': 'movie_theater',
  'бар': 'night_club',
  'клуб': 'night_club',
  'майданчик': 'playground',
  'пляж': 'natural_feature',
  'озеро': 'natural_feature',
  'річка': 'natural_feature',
  'природа': 'natural_feature',
};

// ─── Google Maps API Wrappers ───────────────────────────────────────────────────

function getPlacesService(): google.maps.places.PlacesService {
  if (!window.google || !window.google.maps || !window.google.maps.places) {
    throw new Error("Google Maps Places API is not loaded.");
  }
  return new google.maps.places.PlacesService(document.createElement('div'));
}

export async function findPlaceByName(placeName: string, userLocation: [number, number]): Promise<Place | null> {
  return new Promise((resolve) => {
    const service = getPlacesService();
    const request: google.maps.places.TextSearchRequest = {
      query: placeName,
      location: new google.maps.LatLng(userLocation[1], userLocation[0]),
      radius: 50000,
    };

    service.textSearch(request, (results: google.maps.places.PlaceResult[] | null, status: any) => {
      if (status === 'OK' && results && results.length > 0) {
        const place = results[0];
        resolve({
          name: place.name || placeName,
          coordinates: [place.geometry!.location!.lng(), place.geometry!.location!.lat()],
          type: place.types?.[0] || 'custom',
          address: place.formatted_address,
          rating: place.rating,
          userRatingsTotal: place.user_ratings_total,
          source: 'google',
          externalId: place.place_id,
        });
      } else {
        resolve(null);
      }
    });
  });
}

async function findPlacesByGoogleType(center: [number, number], type: string, radius: number): Promise<Place[]> {
  return new Promise((resolve) => {
    const service = getPlacesService();
    const request: google.maps.places.PlaceSearchRequest = {
      location: new google.maps.LatLng(center[1], center[0]),
      radius: radius,
      type: type,
    };

    service.nearbySearch(request, (results: google.maps.places.PlaceResult[] | null, status: any) => {
      if (status === 'OK' && results) {
        const places: Place[] = results.map((p: google.maps.places.PlaceResult) => ({
          name: p.name || 'Unknown',
          coordinates: [p.geometry!.location!.lng(), p.geometry!.location!.lat()],
          type: type,
          address: p.vicinity,
          rating: p.rating,
          userRatingsTotal: p.user_ratings_total,
          source: 'google',
          externalId: p.place_id,
        }));
        resolve(places);
      } else {
        resolve([]);
      }
    });
  });
}

// ─── Послідовний пошук POI: одна категорія за раз, від кожної зупинки ─────────

function placeKey(place: Place): string {
  return place.externalId || `${place.name}_${place.coordinates[0].toFixed(3)}`;
}

function uniqueCategories(categories: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cat of categories) {
    if (!seen.has(cat)) {
      seen.add(cat);
      result.push(cat);
    }
  }
  return result;
}

async function findSequentialWaypoints(
  startLocation: [number, number],
  options: {
    categories: string[];
    targetTimeMinutes: number;
    routeMode: 'exploration' | 'point_to_point';
    endLocation?: [number, number];
  }
): Promise<Place[]> {
  const { targetTimeMinutes, routeMode, endLocation } = options;
  const searchCategories = uniqueCategories(
    options.categories.length > 0 ? options.categories : ['park', 'cafe', 'tourist_attraction']
  );
  const maxAllowedKm = timeToDistanceKm(targetTimeMinutes) * 1.15;
  const finalEnd = endLocation ?? startLocation;

  const selected: Place[] = [];
  const visited = new Set<string>();
  let current = startLocation;
  let totalDistKm = 0;

  for (const targetCategory of searchCategories) {
    const remainingBudgetKm = maxAllowedKm - totalDistKm;
    if (remainingBudgetKm < 0.15) break;

    const searchRadiusM = Math.max(
      400,
      Math.min(2500, Math.floor(remainingBudgetKm * 1000 * 0.5))
    );

    const batch = await findPlacesByGoogleType(current, targetCategory, searchRadiusM);

    const candidates: Place[] = [];
    for (const place of batch) {
      const key = placeKey(place);
      if (!visited.has(key)) {
        candidates.push(place);
      }
    }

    if (candidates.length === 0) continue;

    const maxDistInBatch = Math.max(
      ...candidates.map(c => getDistanceKm(current, c.coordinates)),
      0.1
    );

    const feasible = candidates.filter(candidate => {
      const legKm = getDistanceKm(current, candidate.coordinates);
      if (routeMode === 'exploration') {
        return totalDistKm + legKm <= maxAllowedKm;
      }
      const returnKm = getDistanceKm(candidate.coordinates, finalEnd);
      return totalDistKm + legKm + returnKm <= maxAllowedKm;
    });

    const picked = feasible.length > 0
      ? feasible.sort((a, b) =>
          scorePlaceOnPath(b, current, maxDistInBatch) - scorePlaceOnPath(a, current, maxDistInBatch)
        )[0]
      : null;

    if (!picked) continue;

    visited.add(placeKey(picked));
    totalDistKm += getDistanceKm(current, picked.coordinates);
    selected.push(picked);
    current = picked.coordinates;
  }

  return selected;
}

function placesToWaypoints(places: Place[]): RouteWaypoint[] {
  return places.map(wp => {
    const terrain = getTerrainInfo(wp.type);
    return {
      location: [wp.coordinates[1], wp.coordinates[0]] as [number, number],
      name: wp.name,
      type: wp.type as PoiCategory,
      address: wp.address,
      rating: wp.rating,
      userRatingsTotal: wp.userRatingsTotal,
      photoUrl: wp.photoUrl,
      externalId: wp.externalId,
      description: `Покриття: ${terrain.surfaceType} | Мальовничість: ${terrain.scenicScore}`,
      source: 'google' as const,
    };
  });
}

async function buildFinalRoute(
  userLocation: [number, number],
  endCoord: [number, number],
  pois: Place[]
): Promise<RouteResult> {
  const route = await buildRoute(userLocation, endCoord, pois.map(p => p.coordinates));
  route.waypoints = placesToWaypoints(pois);
  route.locations = pois.map(wp => wp.name);
  return route;
}

export async function resolveDestination(
  userLocation: [number, number],
  destination?: RouteDestination
): Promise<{ coords: [number, number]; name: string; address?: string } | null> {
  if (!destination) return null;

  if (destination.coords) {
    return {
      coords: destination.coords,
      name: destination.name || destination.address || 'Пункт призначення',
      address: destination.address,
    };
  }

  if (destination.address) {
    const geocoded = await geocodeAddress(destination.address);
    if (!geocoded) return null;
    return {
      coords: geocoded.coords,
      name: destination.name || geocoded.formattedAddress,
      address: geocoded.formattedAddress,
    };
  }

  return null;
}

export async function generateRouteByFilters(
  userLocation: [number, number],
  options: RouteFilterOptions
): Promise<RouteResult> {
  const { routeMode } = options;

  if (routeMode === 'point_to_point' && (!options.destination?.coords && !options.destination?.address)) {
    throw new Error('Для прямого маршруту вкажіть адресу або оберіть точку на карті.');
  }

  let endCoord: [number, number] | null = null;
  let destinationPlace: Place | null = null;

  if (routeMode === 'point_to_point') {
    const resolved = await resolveDestination(userLocation, options.destination);
    if (!resolved) {
      throw new Error('Не вдалося знайти вказану адресу. Перевірте правильність написання.');
    }
    endCoord = resolved.coords;
    destinationPlace = {
      name: resolved.name,
      coordinates: resolved.coords,
      type: 'custom',
      address: resolved.address,
      source: 'custom',
    };
  }

  const sequencedPois = await findSequentialWaypoints(userLocation, {
    categories: options.categories,
    targetTimeMinutes: options.targetTimeMinutes,
    routeMode,
    endLocation: endCoord ?? undefined,
  });

  if (routeMode === 'exploration') {
    if (sequencedPois.length === 0) {
      throw new Error(
        `Не знайдено місць обраних категорій за ~${options.targetTimeMinutes} хв прогулянки. Спробуйте інші категорії або збільште час.`
      );
    }
    endCoord = sequencedPois[sequencedPois.length - 1].coordinates;
  }

  if (sequencedPois.length === 0 && routeMode === 'point_to_point') {
    const directRoute = await buildRoute(userLocation, endCoord!, []);
    if (destinationPlace) {
      directRoute.waypoints = [{
        location: [destinationPlace.coordinates[1], destinationPlace.coordinates[0]],
        name: destinationPlace.name,
        type: 'custom',
        address: destinationPlace.address,
        source: 'custom',
      }];
      directRoute.locations = [destinationPlace.name];
    }
    return directRoute;
  }

  const routingPois =
    routeMode === 'exploration'
      ? (sequencedPois.length > 1 ? sequencedPois.slice(0, -1) : [])
      : sequencedPois;

  const route = await buildFinalRoute(userLocation, endCoord!, routingPois);

  if (routeMode === 'exploration') {
    route.waypoints = placesToWaypoints(sequencedPois);
    route.locations = sequencedPois.map(wp => wp.name);
  }

  if (destinationPlace) {
    route.waypoints.push({
      location: [destinationPlace.coordinates[1], destinationPlace.coordinates[0]],
      name: destinationPlace.name,
      type: 'custom',
      address: destinationPlace.address,
      source: 'custom',
    });
    route.locations.push(destinationPlace.name);
  }

  return route;
}

export async function searchComprehensivePois(
  center: [number, number], 
  desiredTypes: string[], 
  radius: number = 3000
): Promise<Place[]> {
  const allResults: Place[] = [];
  const searchTypes = desiredTypes.length > 0 ? desiredTypes : EXTENDED_POI_TYPES;
  
  for (const type of searchTypes) {
    const places = await findPlacesByGoogleType(center, type, radius);
    allResults.push(...places);
  }

  const uniquePlaces = new Map<string, Place>();
  for (const place of allResults) {
    const key = place.externalId || `${place.name}_${place.coordinates[0].toFixed(3)}`;
    if (!uniquePlaces.has(key)) {
      uniquePlaces.set(key, place);
    }
  }

  const finalPois = Array.from(uniquePlaces.values());
  return filterPoisByDiversity(finalPois);
}

function filterPoisByDiversity(pois: Place[]): Place[] {
  const categoryCounts: Record<string, number> = {};
  const diversePois: Place[] = [];
  const sortedPois = pois.sort((a, b) => (b.rating || 0) - (a.rating || 0));

  for (const poi of sortedPois) {
    const cat = poi.type || 'custom';
    if (!categoryCounts[cat]) categoryCounts[cat] = 0;
    
    if (categoryCounts[cat] < 2) {
      diversePois.push(poi);
      categoryCounts[cat]++;
    }
  }
  return diversePois;
}

export async function buildRoute(
  userLocation: [number, number], // [lng, lat]
  destination: [number, number], // [lng, lat]
  waypoints: [number, number][] = [] // [lng, lat]
): Promise<RouteResult> {
  return new Promise((resolve, reject) => {
    if (!window.google || !window.google.maps || !window.google.maps.DirectionsService) {
      return reject(new Error("Google Maps DirectionsService is not loaded."));
    }

    const directionsService = new google.maps.DirectionsService();
    
    const request: google.maps.DirectionsRequest = {
      origin: new google.maps.LatLng(userLocation[1], userLocation[0]),
      destination: new google.maps.LatLng(destination[1], destination[0]),
      waypoints: waypoints.map(wp => ({
        location: new google.maps.LatLng(wp[1], wp[0]),
        stopover: true
      })),
      travelMode: google.maps.TravelMode.WALKING,
      optimizeWaypoints: false, 
    };

    directionsService.route(request, async (result: google.maps.DirectionsResult | null, status: any) => {
      if (status === 'OK' && result) {
        const route = result.routes[0];
        
        let totalDistanceMeters = 0;
        let totalDurationSeconds = 0;
        const points: [number, number][] = [];
        const steps: RouteStep[] = [];

        route.legs.forEach((l: google.maps.DirectionsLeg) => {
          totalDistanceMeters += l.distance?.value || 0;
          totalDurationSeconds += l.duration?.value || 0;
          l.steps.forEach((step: google.maps.DirectionsStep) => {
            steps.push({
              instruction: stripHtml(step.instructions || ''),
              distanceMeters: step.distance?.value || 0,
              durationSeconds: step.duration?.value || 0,
              endLocation: [
                step.end_location.lat(),
                step.end_location.lng(),
              ],
              maneuver: step.maneuver,
            });
            step.path.forEach((latLng: google.maps.LatLng) => {
              points.push([latLng.lat(), latLng.lng()]);
            });
          });
        });

        const distanceKm = parseFloat((totalDistanceMeters / 1000).toFixed(2));
        const estimatedTimeMinutes = Math.round(totalDurationSeconds / 60);

        const elevationProfile = await calculateElevationProfile(points);
        const difficulty = calculateRouteDifficulty(distanceKm, elevationProfile, 1.0);

        const waypointsWithNames = waypoints.map((wp, index) => ({
          location: [wp[1], wp[0]] as [number, number],
          name: `Stop ${index + 1}`,
          type: 'custom' as PoiCategory,
        }));

        resolve({
          points,
          waypoints: waypointsWithNames,
          steps,
          distanceKm,
          estimatedTimeMinutes,
          locations: [],
          difficulty,
          elevation: elevationProfile || undefined
        });
      } else {
        reject(new Error(`Failed to build route: ${status}`));
      }
    });
  });
}

export async function generateExplorationRoute(
  userLocation: [number, number], 
  options: {
    types: string[];
    targetTimeMinutes?: number;
  }
): Promise<RouteResult> {
  const { types, targetTimeMinutes = 60 } = options;

  return generateRouteByFilters(userLocation, {
    routeMode: 'exploration',
    categories: types,
    targetTimeMinutes,
  });
}

export interface ParsedRouteRequest {
  destinationType: string | null;
  destinationName: string | null;
  categories: string[];
  waypointTypes: string[];
  waypointNames: string[];
  targetTimeMinutes: number;
  isExplorationMode: boolean;
  isPointToPoint: boolean;
}

function extractCategoriesInOrder(text: string): string[] {
  const lowerText = text.toLowerCase();
  const keys = Object.keys(PLACE_TYPE_MAPPING).sort((a, b) => b.length - a.length);
  const found: { index: number; type: string }[] = [];

  for (const key of keys) {
    let idx = lowerText.indexOf(key);
    while (idx !== -1) {
      found.push({ index: idx, type: PLACE_TYPE_MAPPING[key] });
      idx = lowerText.indexOf(key, idx + 1);
    }
  }

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .filter(f => {
      if (seen.has(f.type)) return false;
      seen.add(f.type);
      return true;
    })
    .map(f => f.type);
}

export function parseRouteRequest(text: string): ParsedRouteRequest {
  const lowerText = text.toLowerCase().trim();
  const categories = extractCategoriesInOrder(text);

  let destinationName: string | null = null;
  let destinationType: string | null = null;
  const waypointNames: string[] = [];
  const waypointTypes: string[] = [];

  const destMatch = text.match(
    /(?:до|в|на)\s+([А-Яа-яІіЇїЄєҐґA-Za-z0-9][А-Яа-яІіЇїЄєҐґA-Za-z0-9\s\-'']{2,}?)(?=\s+(?:через|з|із|за|і|та|,)|$)/i
  );
  if (destMatch?.[1]) {
    const destText = destMatch[1].trim().toLowerCase();
    const matchedType = Object.entries(PLACE_TYPE_MAPPING).find(([key]) => destText.includes(key));
    if (matchedType) {
      destinationType = matchedType[1];
    } else {
      destinationName = destMatch[1].trim();
    }
  }

  const throughMatches = text.matchAll(
    /через\s+([А-Яа-яІіЇїЄєҐґA-Za-z0-9][А-Яа-яІіЇїЄєҐґA-Za-z0-9\s\-'']*)/gi
  );
  for (const match of throughMatches) {
    const segment = match[1].trim().toLowerCase();
    const typeEntry = Object.entries(PLACE_TYPE_MAPPING).find(([key]) => segment.includes(key));
    if (typeEntry) {
      waypointTypes.push(typeEntry[1]);
    } else if (segment.length >= 3) {
      waypointNames.push(match[1].trim());
    }
  }

  const withMatches = text.matchAll(
    /(?:з|із)\s+([а-яіїєґa-z][а-яіїєґa-z\s\-'']+)/gi
  );
  for (const match of withMatches) {
    const segment = match[1].trim().toLowerCase();
    const typeEntry = Object.entries(PLACE_TYPE_MAPPING).find(([key]) => segment.includes(key));
    if (typeEntry) waypointTypes.push(typeEntry[1]);
  }

  const isExplorationMode =
    /\b(прогулянка|прогулятись|прогулятися|кільцев|коло|по місту)\b/i.test(lowerText);
  const isPointToPoint =
    /\b(до точки|прямий|прямо)\b/i.test(lowerText) ||
    (!!destinationName && !isExplorationMode);

  let targetTimeMinutes = 60;
  const hourMatch = lowerText.match(/(\d+)\s*(год|годин|години|h\b)/i);
  const minMatch = lowerText.match(/(\d+)\s*(хв|хвилин|хвилини|min)/i);
  if (hourMatch?.[1]) {
    targetTimeMinutes = Math.max(15, Math.min(parseInt(hourMatch[1]) * 60, 240));
    if (minMatch?.[1]) {
      targetTimeMinutes += parseInt(minMatch[1]);
    }
  } else if (minMatch?.[1]) {
    targetTimeMinutes = Math.max(15, Math.min(parseInt(minMatch[1]), 240));
  }

  const allCategories = uniqueCategories([
    ...categories,
    ...waypointTypes,
    ...(destinationType ? [destinationType] : []),
  ]);

  return {
    destinationType,
    destinationName,
    categories: allCategories,
    waypointTypes: uniqueCategories(waypointTypes),
    waypointNames,
    targetTimeMinutes,
    isExplorationMode: isExplorationMode || (!isPointToPoint && !destinationName),
    isPointToPoint,
  };
}

export async function generateRouteFromText(
  userLocation: [number, number],
  text: string,
  options?: { routeMode?: "point_to_point" | "exploration" }
): Promise<RouteResult> {
  const parsed = parseRouteRequest(text);
  const routeMode = options?.routeMode
    ?? (parsed.isExplorationMode ? 'exploration' : parsed.isPointToPoint ? 'point_to_point' : 'exploration');

  const visitCategories = uniqueCategories(
    parsed.categories.filter(c => c !== parsed.destinationType || routeMode === 'exploration')
  );

  if (routeMode === 'exploration') {
    if (visitCategories.length === 0) {
      throw new Error('Вкажіть, що хочете відвідати (парк, кав\'ярня, музей тощо).');
    }
    return generateRouteByFilters(userLocation, {
      routeMode: 'exploration',
      categories: visitCategories,
      targetTimeMinutes: parsed.targetTimeMinutes,
    });
  }

  let destination: Place | null = null;

  if (parsed.destinationName) {
    destination = await findPlaceByName(parsed.destinationName, userLocation);
  } else if (parsed.destinationType) {
    const pois = await findPlacesByGoogleType(userLocation, parsed.destinationType, 5000);
    destination = pickBestRatedPlace(pois, userLocation);
  }

  if (!destination) {
    throw new Error('Не вдалося знайти пункт призначення. Уточніть адресу або назву місця.');
  }

  const namedWaypoints: Place[] = [];
  for (const wName of parsed.waypointNames) {
    const wp = await findPlaceByName(wName, userLocation);
    if (wp) namedWaypoints.push(wp);
  }

  const categoryWaypoints = visitCategories.length > 0
    ? await findSequentialWaypoints(userLocation, {
        categories: visitCategories,
        targetTimeMinutes: parsed.targetTimeMinutes,
        routeMode: 'point_to_point',
        endLocation: destination.coordinates,
      })
    : [];

  const allWaypoints = [...namedWaypoints, ...categoryWaypoints];
  const route = await buildFinalRoute(userLocation, destination.coordinates, allWaypoints);

  route.waypoints.push({
    location: [destination.coordinates[1], destination.coordinates[0]],
    name: destination.name,
    type: (destination.type || 'custom') as PoiCategory,
    address: destination.address,
    rating: destination.rating,
    userRatingsTotal: destination.userRatingsTotal,
    externalId: destination.externalId,
    source: destination.source ?? 'google',
  });
  route.locations.push(destination.name);

  return route;
}

// ─── Збережені маршрути та Пошук POI ────────────────────────────────

export async function navigateToSavedRoute(
  userLocation: [number, number],
  savedRoute: RouteResult
): Promise<RouteResult> {
  if (!savedRoute.points || savedRoute.points.length === 0) {
    throw new Error("Збережений маршрут не має точок.");
  }
  
  const startPoint = savedRoute.points[0];
  const destCoords: [number, number] = [startPoint[1], startPoint[0]];
  
  const distToStartKm = getDistanceKm(userLocation, destCoords);
  if (distToStartKm < 0.05) {
    return savedRoute;
  }
  
  const approachRoute = await buildRoute(userLocation, destCoords, []);
  
  return {
    ...savedRoute,
    points: [...approachRoute.points, ...savedRoute.points],
    steps: [...(approachRoute.steps || []), ...(savedRoute.steps || [])],
    distanceKm: parseFloat((savedRoute.distanceKm + approachRoute.distanceKm).toFixed(2)),
    estimatedTimeMinutes: savedRoute.estimatedTimeMinutes + approachRoute.estimatedTimeMinutes,
    waypoints: savedRoute.waypoints
  };
}

export async function reanalyzeRoutePois(
  routePoints: [number, number][],
  categories: string[]
): Promise<RouteWaypoint[]> {
  const samplePoints = routePoints.filter((_, index) => index % 50 === 0);
  
  if (routePoints.length > 0 && !samplePoints.includes(routePoints[routePoints.length - 1])) {
    samplePoints.push(routePoints[routePoints.length - 1]);
  }

  const allFoundPois: Place[] = [];
  
  for (const point of samplePoints) {
    const lngLatPoint: [number, number] = [point[1], point[0]];
    const pois = await searchComprehensivePois(lngLatPoint, categories, 400); 
    allFoundPois.push(...pois);
  }

  const uniquePois = new Map<string, Place>();
  allFoundPois.forEach(poi => {
    const key = poi.externalId || poi.name;
    if (!uniquePois.has(key)) uniquePois.set(key, poi);
  });

  // Рахуємо мінімальну відстань від кожного знайденого місця до лінії маршруту
  const poisWithDistance = Array.from(uniquePois.values()).map(poi => {
    let minDistance = Infinity;
    for (const pt of samplePoints) {
      const dist = getDistanceKm([pt[1], pt[0]], poi.coordinates);
      if (dist < minDistance) minDistance = dist;
    }
    return { poi, minDistance };
  });

  const selectedPois: Place[] = [];

//  беремо  1 найближчу точку для кожної категорії
  const maxPerCategory = 1;

  for (const category of categories) {
    const categoryPois = poisWithDistance
      .filter(p => p.poi.type === category)
      .sort((a, b) => a.minDistance - b.minDistance);

    const topForCategory = categoryPois.slice(0, maxPerCategory).map(p => p.poi);
    
    for (const p of topForCategory) {
        if (!selectedPois.find(sp => sp.externalId === p.externalId)) {
            selectedPois.push(p);
        }
    }
  }

  // Якщо фільтрація по типах не спрацювала ідеально, беремо просто найближчі 2 точки
  if (selectedPois.length === 0 && poisWithDistance.length > 0) {
      poisWithDistance.sort((a, b) => a.minDistance - b.minDistance);
      selectedPois.push(...poisWithDistance.slice(0, 1).map(p => p.poi));
  }

  return selectedPois.map(poi => ({
    location: [poi.coordinates[1], poi.coordinates[0]],
    name: poi.name,
    type: (poi.type || 'custom') as PoiCategory,
    address: poi.address,
    rating: poi.rating,
    source: 'google',
    externalId: poi.externalId
  }));
}

export async function rebuildRouteWithNewPois(
  currentRoute: RouteResult,
  categories: string[]
): Promise<RouteResult> {
  const newWaypoints = await reanalyzeRoutePois(currentRoute.points, categories);

  if (newWaypoints.length === 0) {
    throw new Error("Не знайдено підходящих місць за обраними фільтрами поруч із маршрутом.");
  }

  const limitedNewWaypoints = newWaypoints.slice(0, 5);

  const existingWaypointsCoords = (currentRoute.waypoints || []).map(wp => [wp.location[1], wp.location[0]] as [number, number]);
  const newWaypointsCoords = limitedNewWaypoints.map(wp => [wp.location[1], wp.location[0]] as [number, number]);
  
  const allCoords = [...existingWaypointsCoords, ...newWaypointsCoords].slice(-8);

  const startPoint = currentRoute.points[0];
  const endPoint = currentRoute.points[currentRoute.points.length - 1];

  const startLngLat: [number, number] = [startPoint[1], startPoint[0]];
  const endLngLat: [number, number] = [endPoint[1], endPoint[0]];

  const rebuiltRoute = await buildRoute(startLngLat, endLngLat, allCoords);

  const finalWaypoints = [
    ...(currentRoute.waypoints || []),
    ...limitedNewWaypoints
  ];

  return {
    ...rebuiltRoute,
    waypoints: finalWaypoints,
    name: currentRoute.name,
    description: currentRoute.description,
    preferences: currentRoute.preferences
  };
}