/// <reference types="google.maps" />
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle, useCallback } from "react";
import { generateRouteFromText, RouteResult, RouteWaypoint } from "../services/routeService";
import { reverseGeocode } from "../services/placesService";
import type { SavedRoute } from "../services/supabaseService";
import type { RouteDifficulty } from "../types/routeEnhancements";
import {
  findCurrentStepIndex,
  findRouteProgress,
  calculateRemainingRouteStats,
  formatRemainingRouteSummary,
  getStepRemainingToEnd,
  buildCumulativeDistancesKm,
  isLoopRoute,
} from "../utils/routeTracking";
import {
  startWalkProgressSession,
  updateWalkProgressTraveledKm,
  finishWalkProgressSession,
  loadWalkProgress,
} from "../utils/walkProgressStorage";
import { syncPendingWalkStatistics } from "../services/walkStatisticSync";
import PlaceInfoCard from "./PlaceInfoCard";
import NavigationStepsPanel from "./NavigationStepsPanel";
import RouteCompletionCelebration from "./RouteCompletionCelebration";

export interface WalkPreferences {
  prompt: string;
  locations: string[];
  distance?: number;
  duration?: number;
  routeMode?: "point_to_point" | "exploration";
}

export interface RouteMapRef {
  generateRoute: (preferences: WalkPreferences) => Promise<void>;
  loadSavedRoute: (route: SavedRoute) => Promise<void>;
  requestGeolocation: () => void;
  getCurrentRoute: () => RouteResult | null;
  clearCurrentRoute: () => void;
  isGenerating: boolean;
  centerOnUser: () => void;
  refreshMapLayout: () => void;
}

interface RouteMapProps {
  onRouteSummary?: (summary: string) => void;
  onRouteGenerated?: (data: {
    distanceKm: number;
    locations: string[];
    prompt?: string;
    estimatedTimeMinutes: number;
    difficulty?: RouteDifficulty;
  }) => void;
  panelExpanded?: boolean;
  pickDestinationMode?: boolean;
  onDestinationPicked?: (coords: [number, number], address: string) => void;
  onPickCancel?: () => void;
  routeSummary?: string;
  showSaveButton?: boolean;
  onSaveRoute?: () => void;
}

const TYPE_COLOR_MAP: Record<string, string> = {
  cafe: "#ff8c00", park: "#4caf50", restaurant: "#ff5722", shop: "#3f51b5", store: "#3f51b5",
  museum: "#9c27b0", library: "#03a9f4", church: "#795548", beach: "#ffc107",
  lake: "#2196f3", river: "#00bcd4", tourist_attraction: "#ef5350", custom: "#6c757d",
  bakery: "#d4a574", art_gallery: "#ab47bc", book_store: "#5c6bc0", shopping_mall: "#3949ab",
  gym: "#e53935", spa: "#8d6e63", zoo: "#ff9800", stadium: "#607d8b",
  movie_theater: "#7e57c2", night_club: "#c2185b", playground: "#66bb6a",
};

function createSvgIcon(emoji: string, color: string): google.maps.Icon {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <circle cx="18" cy="18" r="15" fill="${color}" stroke="#fff" stroke-width="2.5"/>
    <text x="18" y="23" font-size="14" text-anchor="middle" font-family="sans-serif">${emoji}</text>
  </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(36, 36),
    anchor: new google.maps.Point(18, 18),
  };
}

function createNumberedIcon(number: number, color: string): google.maps.Icon {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="14" fill="${color}" stroke="#fff" stroke-width="2"/>
    <text x="16" y="21" font-size="13" font-weight="bold" text-anchor="middle" fill="#fff" font-family="sans-serif">${number}</text>
  </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(32, 32),
    anchor: new google.maps.Point(16, 16),
  };
}

function createUserLocationIcon(heading: number): google.maps.Icon {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 52 52">
    <g transform="rotate(${heading}, 26, 26)">
      <path d="M26 6 C26 6 34 22 34 28 C34 32 30 36 26 36 C22 36 18 32 18 28 C18 22 26 6 26 6Z" fill="#4285F4" fill-opacity="0.55" stroke="#4285F4" stroke-width="1"/>
    </g>
    <circle cx="26" cy="26" r="8" fill="#4285F4" stroke="#fff" stroke-width="3"/>
    <circle cx="26" cy="26" r="3" fill="#fff"/>
  </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(52, 52),
    anchor: new google.maps.Point(26, 26),
  };
}

function getCompassHeading(event: DeviceOrientationEvent): number | null {
  const e = event as DeviceOrientationEvent & { webkitCompassHeading?: number };
  if (typeof e.webkitCompassHeading === 'number') {
    return e.webkitCompassHeading;
  }
  if (event.absolute && event.alpha !== null) {
    return (360 - event.alpha) % 360;
  }
  return null;
}

const RouteMap = forwardRef<RouteMapRef, RouteMapProps>(
  ({
    onRouteSummary,
    onRouteGenerated,
    pickDestinationMode,
    onDestinationPicked,
    onPickCancel,
    routeSummary,
    showSaveButton,
    onSaveRoute,
  }, ref) => {
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<google.maps.Map | null>(null);
    const traveledLineRef = useRef<google.maps.Polyline | null>(null);
    const remainingLineRef = useRef<google.maps.Polyline | null>(null);
    const markersRef = useRef<google.maps.Marker[]>([]);
    const destinationMarkerRef = useRef<google.maps.Marker | null>(null);
    const userMarkerRef = useRef<google.maps.Marker | null>(null);
    const mapClickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
    const watchIdRef = useRef<number | null>(null);
    const headingRef = useRef<number>(0);
    const userLocationRef = useRef<[number, number] | null>(null);

    const [isGenerating, setIsGenerating] = useState(false);
    const [selectedPoi, setSelectedPoi] = useState<{ waypoint: RouteWaypoint; stopNumber?: number } | null>(null);
    const [currentStepIndex, setCurrentStepIndex] = useState(0);
    const [currentStepRemaining, setCurrentStepRemaining] = useState<{
      distanceMeters: number;
      durationSeconds: number;
    } | null>(null);
    const [hasActiveRoute, setHasActiveRoute] = useState(false);
    const [showRouteCompletion, setShowRouteCompletion] = useState(false);
    const currentRouteRef = useRef<RouteResult | null>(null);
    const routeCompletedRef = useRef(false);
    const maxProgressIndexRef = useRef(0);
    const maxTraveledKmRef = useRef(0);
    const cumulativeDistancesRef = useRef<number[]>([]);
    const isLoopRouteRef = useRef(false);
    const onRouteSummaryRef = useRef(onRouteSummary);

    useEffect(() => {
      onRouteSummaryRef.current = onRouteSummary;
    }, [onRouteSummary]);

    useEffect(() => {
      if (!hasActiveRoute) return;

      const logProgress = () => {
        const progress = loadWalkProgress();
        if (!progress) return;
        console.log(
          '[Walkify] Пройдена відстань:',
          `${progress.traveledKm.toFixed(3)} км`,
          `(${progress.isActive ? 'активна прогулянка' : 'завершена'})`
        );
      };

      logProgress();
      const intervalId = window.setInterval(logProgress, 10_000);
      return () => window.clearInterval(intervalId);
    }, [hasActiveRoute]);

    const updateUserMarker = useCallback((lngLat: [number, number], heading?: number | null) => {
      const map = mapRef.current;
      if (!map) return;

      if (heading !== null && heading !== undefined && !Number.isNaN(heading)) {
        headingRef.current = heading;
      }

      userLocationRef.current = lngLat;

      const pos = { lat: lngLat[1], lng: lngLat[0] };
      if (!userMarkerRef.current) {
        userMarkerRef.current = new google.maps.Marker({
          position: pos,
          map,
          icon: createUserLocationIcon(headingRef.current),
          zIndex: 999,
          title: 'Ваше місцезнаходження',
        });
      } else {
        userMarkerRef.current.setPosition(pos);
        userMarkerRef.current.setIcon(createUserLocationIcon(headingRef.current));
        if (!userMarkerRef.current.getMap()) {
          userMarkerRef.current.setMap(map);
        }
      }
    }, []);

    const updateRouteProgress = useCallback((userLngLat: [number, number]) => {
      const route = currentRouteRef.current;
      if (!route?.points.length) return;

      const progress = findRouteProgress(
        route.points,
        userLngLat,
        maxProgressIndexRef.current,
        maxTraveledKmRef.current,
        cumulativeDistancesRef.current
      );

      if (progress.distanceFromRouteKm > 0.12) return;

      const idx = Math.max(maxProgressIndexRef.current, progress.segmentIndex);
      maxProgressIndexRef.current = idx;
      maxTraveledKmRef.current = Math.max(maxTraveledKmRef.current, progress.traveledKm);

      const snap = { lat: progress.snappedPoint[0], lng: progress.snappedPoint[1] };
      const toLatLng = (p: [number, number]) => ({ lat: p[0], lng: p[1] });

      const traveledPath = [
        ...route.points.slice(0, idx + 1).map(toLatLng),
        snap,
      ];
      const remainingPath = [
        snap,
        ...route.points.slice(idx + 1).map(toLatLng),
      ];

      traveledLineRef.current?.setPath(traveledPath);
      remainingLineRef.current?.setPath(remainingPath);

      let stepIdx: number | undefined;
      if (route.steps?.length) {
        stepIdx = findCurrentStepIndex(
          route.steps,
          [userLngLat[1], userLngLat[0]],
          idx,
          route.points.length,
          isLoopRouteRef.current
        );
        setCurrentStepIndex(stepIdx);
        const step = route.steps[stepIdx];
        if (step) {
          setCurrentStepRemaining(getStepRemainingToEnd(step, userLngLat));
        }
      }

      const totalRouteKm = cumulativeDistancesRef.current.at(-1) ?? route.distanceKm;
      const stats = calculateRemainingRouteStats(
        route,
        idx,
        stepIdx,
        maxTraveledKmRef.current,
        totalRouteKm
      );
      onRouteSummaryRef.current?.(formatRemainingRouteSummary(stats));

      updateWalkProgressTraveledKm(maxTraveledKmRef.current, totalRouteKm);

      const traveledRatio =
        totalRouteKm > 0 ? maxTraveledKmRef.current / totalRouteKm : 0;
      const nearEnd =
        stats.remainingDistanceKm < 0.08 ||
        traveledRatio >= 0.95 ||
        (idx >= route.points.length - 2 && progress.distanceFromRouteKm < 0.08);

      if (
        !routeCompletedRef.current &&
        totalRouteKm > 0.15 &&
        nearEnd
      ) {
        routeCompletedRef.current = true;
        setShowRouteCompletion(true);
        onRouteSummaryRef.current?.("Маршрут завершено! 🎉");
      }
    }, []);

    const startLocationTracking = useCallback(() => {
      if (!navigator.geolocation) return;

      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }

      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const lngLat: [number, number] = [pos.coords.longitude, pos.coords.latitude];
          const heading = pos.coords.heading;
          updateUserMarker(lngLat, heading);
          if (currentRouteRef.current) {
            updateRouteProgress(lngLat);
          }
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
      );
    }, [updateUserMarker, updateRouteProgress]);

    useEffect(() => {
      if (!mapContainerRef.current || !window.google) return;

      const map = new google.maps.Map(mapContainerRef.current, {
        center: { lat: 50.4501, lng: 30.5234 },
        zoom: 13,
        disableDefaultUI: true,
        zoomControl: false, // Відключаємо кнопки зуму +/-
        clickableIcons: false,
        gestureHandling: 'greedy',
      });
      mapRef.current = map;

      navigator.geolocation.getCurrentPosition((pos) => {
        const loc: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        updateUserMarker(loc, pos.coords.heading);
        map.setCenter({ lat: loc[1], lng: loc[0] });
      });

      startLocationTracking();

      const onOrientation = (event: DeviceOrientationEvent) => {
        const compass = getCompassHeading(event);
        if (compass !== null && userLocationRef.current) {
          updateUserMarker(userLocationRef.current, compass);
        }
      };

      window.addEventListener('deviceorientationabsolute', onOrientation as EventListener);
      window.addEventListener('deviceorientation', onOrientation as EventListener);

      return () => {
        if (watchIdRef.current !== null) {
          navigator.geolocation.clearWatch(watchIdRef.current);
        }
        window.removeEventListener('deviceorientationabsolute', onOrientation as EventListener);
        window.removeEventListener('deviceorientation', onOrientation as EventListener);
      };
    }, [startLocationTracking, updateUserMarker]);

    const clearRouteLines = useCallback(() => {
      traveledLineRef.current?.setMap(null);
      remainingLineRef.current?.setMap(null);
      traveledLineRef.current = null;
      remainingLineRef.current = null;
    }, []);

    const clearRouteAndMarkers = useCallback(() => {
      clearRouteLines();
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];
      setSelectedPoi(null);
      setCurrentStepIndex(0);
      setCurrentStepRemaining(null);
      setHasActiveRoute(false);
      currentRouteRef.current = null;
      maxProgressIndexRef.current = 0;
      maxTraveledKmRef.current = 0;
      cumulativeDistancesRef.current = [];
      isLoopRouteRef.current = false;
      routeCompletedRef.current = false;
      setShowRouteCompletion(false);
      const finishedSession = finishWalkProgressSession();
      if (finishedSession) {
        syncPendingWalkStatistics()
          .then((result) => {
            if (result.synced > 0) {
              console.log('[Walkify] Статистику завантажено на сервер:', result);
            }
          })
          .catch((err) => console.error('[Walkify] Синхронізація статистики:', err));
      }
    }, [clearRouteLines]);

    const displayRoute = useCallback((route: RouteResult) => {
      const map = mapRef.current;
      if (!map) return;

      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];
      clearRouteLines();
      setSelectedPoi(null);

      currentRouteRef.current = route;
      routeCompletedRef.current = false;
      setShowRouteCompletion(false);
      maxProgressIndexRef.current = 0;
      maxTraveledKmRef.current = 0;
      cumulativeDistancesRef.current = buildCumulativeDistancesKm(route.points);
      isLoopRouteRef.current = isLoopRoute(route.points);
      const totalRouteKm = cumulativeDistancesRef.current.at(-1) ?? route.distanceKm;
      startWalkProgressSession(totalRouteKm);
      syncPendingWalkStatistics().catch((err) =>
        console.error('[Walkify] Синхронізація попередньої прогулянки:', err)
      );
      setHasActiveRoute(true);
      setCurrentStepIndex(0);
      setCurrentStepRemaining(null);

      const path = route.points.map(p => ({ lat: p[0], lng: p[1] }));

      traveledLineRef.current = new google.maps.Polyline({
        path: path.length > 0 ? [path[0]] : [],
        strokeColor: '#9e9e9e',
        strokeOpacity: 0.85,
        strokeWeight: 6,
        map,
        zIndex: 1,
      });

      remainingLineRef.current = new google.maps.Polyline({
        path,
        strokeColor: '#28a745',
        strokeOpacity: 0.95,
        strokeWeight: 6,
        map,
        zIndex: 2,
      });

      const bounds = new google.maps.LatLngBounds();
      path.forEach(p => bounds.extend(p));
      if (userLocationRef.current) {
        bounds.extend({ lat: userLocationRef.current[1], lng: userLocationRef.current[0] });
      }
      map.fitBounds(bounds);

      route.waypoints.forEach((wp, index) => {
        const color = TYPE_COLOR_MAP[wp.type] || TYPE_COLOR_MAP["custom"];
        const isDestination = index === route.waypoints.length - 1;

        const marker = new google.maps.Marker({
          position: { lat: wp.location[0], lng: wp.location[1] },
          map,
          title: wp.name,
          icon: isDestination
            ? createSvgIcon('🏁', '#dc3545')
            : createNumberedIcon(index + 1, color),
          zIndex: isDestination ? 200 : 100 + index,
        });

        marker.addListener("click", () => {
          setSelectedPoi({ waypoint: wp, stopNumber: isDestination ? undefined : index + 1 });
        });
        markersRef.current.push(marker);
      });

      if (userMarkerRef.current) {
        userMarkerRef.current.setMap(map);
      }

      if (userLocationRef.current) {
        updateRouteProgress(userLocationRef.current);
      } else {
        const initialStats = calculateRemainingRouteStats(route, 0, 0);
        onRouteSummaryRef.current?.(formatRemainingRouteSummary(initialStats));
      }
    }, [clearRouteLines, updateRouteProgress]);

    const setDestinationMarker = useCallback((coords: [number, number]) => {
      const map = mapRef.current;
      if (!map) return;

      destinationMarkerRef.current?.setMap(null);

      destinationMarkerRef.current = new google.maps.Marker({
        position: { lat: coords[1], lng: coords[0] },
        map,
        icon: createSvgIcon('🏁', '#dc3545'),
        title: 'Пункт призначення',
        zIndex: 300,
      });
    }, []);

    useEffect(() => {
      const map = mapRef.current;
      if (!map) return;

      if (mapClickListenerRef.current) {
        google.maps.event.removeListener(mapClickListenerRef.current);
        mapClickListenerRef.current = null;
      }

      if (pickDestinationMode) {
        map.setOptions({ draggableCursor: 'crosshair' });
        mapClickListenerRef.current = map.addListener('click', async (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          const coords: [number, number] = [e.latLng.lng(), e.latLng.lat()];
          const address = await reverseGeocode(coords) || `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`;
          setDestinationMarker(coords);
          onDestinationPicked?.(coords, address);
        });
      } else {
        map.setOptions({ draggableCursor: undefined });
      }

      return () => {
        if (mapClickListenerRef.current) {
          google.maps.event.removeListener(mapClickListenerRef.current);
        }
      };
    }, [pickDestinationMode, onDestinationPicked, setDestinationMarker]);

    const generateRoute = async (preferences: WalkPreferences) => {
      if (!userLocationRef.current) return;
      setIsGenerating(true);
      try {
        const route = await generateRouteFromText(userLocationRef.current, preferences.prompt, { routeMode: preferences.routeMode });
        displayRoute(route);
        onRouteGenerated?.({ ...route, prompt: preferences.prompt });
      } finally {
        setIsGenerating(false);
      }
    };

    const loadSavedRoute = async (route: SavedRoute) => {
      const safeWaypoints: RouteWaypoint[] = ((route as any).waypoints || []).map((wp: any) => ({
        location: wp.location,
        name: wp.name,
        type: wp.type,
        address: wp.address,
        rating: wp.rating,
        userRatingsTotal: wp.userRatingsTotal,
        externalId: wp.externalId,
        source: (wp.source === 'google' || wp.source === 'custom') ? wp.source : 'custom'
      }));

      const routeResult: RouteResult = {
        points: route.points,
        waypoints: safeWaypoints,
        steps: (route as any).steps ?? (route as any).preferences?.steps,
        distanceKm: (route as any).statistics?.distanceKm || 0,
        estimatedTimeMinutes: (route as any).statistics?.estimatedTimeMinutes || 0,
        locations: (route as any).locations || [],
        difficulty: (route as any).difficulty
      };

      displayRoute(routeResult);
    };

    const centerOnUser = useCallback(() => {
      if (userLocationRef.current && mapRef.current) {
        mapRef.current.panTo({ lat: userLocationRef.current[1], lng: userLocationRef.current[0] });
        mapRef.current.setZoom(17);
      }
    }, []);

    const refreshMapLayout = useCallback(() => {
      const map = mapRef.current;
      if (!map || !window.google) return;

      google.maps.event.trigger(map, "resize");
    }, []);

    useImperativeHandle(ref, () => ({
      generateRoute,
      loadSavedRoute,
      requestGeolocation: () => {
        navigator.geolocation.getCurrentPosition((pos) => {
          const loc: [number, number] = [pos.coords.longitude, pos.coords.latitude];
          updateUserMarker(loc, pos.coords.heading);
          mapRef.current?.setCenter({ lat: loc[1], lng: loc[0] });
        });
        startLocationTracking();
      },
      getCurrentRoute: () => currentRouteRef.current,
      clearCurrentRoute: clearRouteAndMarkers,
      centerOnUser,
      refreshMapLayout,
      isGenerating,
    }));

    return (
      <>
        <div ref={mapContainerRef} style={{ width: "100%", height: "100%", position: "absolute" }} />

        {pickDestinationMode && (
          <>
            <div
              className="position-absolute top-0 start-50 translate-middle-x mt-3 px-3 py-2 bg-warning text-dark rounded-pill shadow small fw-semibold"
              style={{ zIndex: 1100, maxWidth: '90%', textAlign: 'center' }}
            >
              <i className="bi bi-crosshair me-1"></i> Торкніться карти — кінець маршруту
            </div>
            {onPickCancel && (
              <button
                type="button"
                className="btn btn-light btn-sm rounded-pill shadow home-pick-cancel"
                onClick={onPickCancel}
              >
                <i className="bi bi-x-lg me-1"></i> Скасувати
              </button>
            )}
          </>
        )}

        {!pickDestinationMode && (routeSummary || (hasActiveRoute && currentRouteRef.current?.steps)) && (
          <div className="home-bottom-stack">
            {routeSummary && (
              <div className="home-route-chip">
                <i className="bi bi-signpost-2 me-1 text-success"></i>
                {routeSummary}
              </div>
            )}
            {hasActiveRoute && currentRouteRef.current?.steps && (
              <NavigationStepsPanel
                steps={currentRouteRef.current.steps}
                currentStepIndex={currentStepIndex}
                remainingDistanceMeters={currentStepRemaining?.distanceMeters}
                remainingDurationSeconds={currentStepRemaining?.durationSeconds}
                onStepClick={setCurrentStepIndex}
              />
            )}
          </div>
        )}

        {!pickDestinationMode && (
          <div className="home-map-actions">
            {showSaveButton && onSaveRoute && (
              <button
                type="button"
                className="home-save-btn"
                onClick={onSaveRoute}
                title="Зберегти маршрут"
                aria-label="Зберегти маршрут"
              >
                <i className="bi bi-bookmark-plus"></i>
              </button>
            )}
            <button
              type="button"
              className="home-locate-btn"
              onClick={centerOnUser}
              title="Моє місцезнаходження"
              aria-label="Центрувати на мені"
            >
              <i className="bi bi-crosshair"></i>
            </button>
          </div>
        )}

        {selectedPoi && !pickDestinationMode && (
          <PlaceInfoCard
            waypoint={selectedPoi.waypoint}
            stopNumber={selectedPoi.stopNumber}
            onClose={() => setSelectedPoi(null)}
          />
        )}

        <RouteCompletionCelebration
          show={showRouteCompletion}
          onDone={() => setShowRouteCompletion(false)}
        />
      </>
    );
  }
);

RouteMap.displayName = "RouteMap";
export default RouteMap;