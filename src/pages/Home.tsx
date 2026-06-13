import React, { useState, useRef, useCallback, useEffect } from "react";
import { Modal, Button, Form } from "react-bootstrap";
import { useNavigate } from "react-router-dom";
import RouteMap, { RouteMapRef } from "../Components/RouteMap";
import WalkPreferences from "../Components/WalkPreferences";
import WalkFiltersMenu from "../Components/WalkFiltersMenu";
import { 
  generateRouteByFilters, 
  generateRouteFromText, 
  RouteFilterOptions, 
  RouteDestination, 
  navigateToSavedRoute, 
  reanalyzeRoutePois 
} from "../services/routeService";
import { useAuth } from "../context/AuthContext";
import { saveRoute } from "../services/supabaseService";
import { buildSavedRouteFromResult, getDefaultRouteName } from "../utils/routeSave";
import "../styles/home.css";

// Категорії для меню редагування POI на збереженому маршруті
const AVAILABLE_CATEGORIES = [
  { id: "park", label: "Парки та природа", emoji: "🌳" },
  { id: "cafe", label: "Кав'ярні", emoji: "☕" },
  { id: "restaurant", label: "Ресторани", emoji: "🍽️" },
  { id: "bakery", label: "Пекарні", emoji: "🥐" },
  { id: "museum", label: "Музеї", emoji: "🏛️" },
  { id: "art_gallery", label: "Галереї", emoji: "🎨" },
  { id: "tourist_attraction", label: "Визначні місця", emoji: "⭐" },
  { id: "store", label: "Магазини", emoji: "🛍️" },
];

interface HomeProps {
  isActive?: boolean;
}

const Home: React.FC<HomeProps> = ({ isActive = true }) => {
  const mapRef = useRef<RouteMapRef>(null);
  const navigate = useNavigate();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<"filters" | "text">("filters");
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [routeSummary, setRouteSummary] = useState<string>("");
  const [hasRoute, setHasRoute] = useState(false);
  const [destination, setDestination] = useState<RouteDestination | null>(null);
  const [isPickingOnMap, setIsPickingOnMap] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [hasOpenedMenu, setHasOpenedMenu] = useState(false);
  
  // Збереження маршруту
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDescription, setSaveDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Спеціальні стани для збереженого маршруту (перегляд)
  const [loadedSavedRoute, setLoadedSavedRoute] = useState<any>(null);
  const [isNavigatingToStart, setIsNavigatingToStart] = useState(false);
  const [isEditingPois, setIsEditingPois] = useState(false);
  const [reselectCategories, setReselectCategories] = useState<string[]>(["park", "cafe"]);

  useEffect(() => {
    if (!isActive) return;
    const frameId = requestAnimationFrame(() => {
      mapRef.current?.refreshMapLayout();
    });
    return () => cancelAnimationFrame(frameId);
  }, [isActive]);

  // Завантаження маршруту зі сховища (перехід з Favorites)
  useEffect(() => {
    if (!isActive) return;
    const raw = localStorage.getItem("routeToView");
    if (!raw) return;

    try {
      const data = JSON.parse(raw);
      if (!data.points?.length || !mapRef.current) return;

      const routeData = {
        name: data.name || "Збережений маршрут",
        description: data.description,
        points: data.points,
        statistics: {
          distanceKm: data.distance_km ?? data.statistics?.distanceKm ?? 0,
          estimatedTimeMinutes: data.statistics?.estimatedTimeMinutes ?? 0,
        },
        waypoints: data.waypoints || [],
        preferences: data.preferences,
      };

      (mapRef.current as any).loadSavedRoute(routeData);
      setLoadedSavedRoute(routeData);
      setHasRoute(true);
      
      if (routeData.statistics.distanceKm) {
        const km = routeData.statistics.distanceKm;
        const min = routeData.statistics.estimatedTimeMinutes;
        setRouteSummary(min ? `${km} км · ~${min} хв` : `${km} км`);
      }
      setSidebarOpen(true);
    } catch (err) {
      console.error("Помилка завантаження routeToView:", err);
    } finally {
      localStorage.removeItem("routeToView");
    }
  }, [isActive]);

  const loadRouteOnMap = useCallback((generatedRoute: Awaited<ReturnType<typeof generateRouteByFilters>>) => {
    if (!mapRef.current) return;
    (mapRef.current as any).loadSavedRoute({
      points: generatedRoute.points,
      statistics: {
        distanceKm: generatedRoute.distanceKm,
        estimatedTimeMinutes: generatedRoute.estimatedTimeMinutes,
      },
      waypoints: generatedRoute.waypoints,
      steps: generatedRoute.steps,
      locations: generatedRoute.locations,
      difficulty: generatedRoute.difficulty,
    });
    setHasRoute(true);
  }, []);

  const handlePickOnMap = useCallback(() => {
    setIsPickingOnMap(true);
    setSidebarOpen(false);
  }, []);

  const handlePickCancel = useCallback(() => {
    setIsPickingOnMap(false);
    setSidebarOpen(true);
  }, []);

  const handleDestinationPicked = useCallback((coords: [number, number], address: string) => {
    setDestination({ coords, address, name: address });
    setIsPickingOnMap(false);
    setSidebarOpen(true);
  }, []);

  // Обгортка для геолокації з timeout щоб уникнути зависання
  const runWithGeolocation = (task: (userLoc: [number, number]) => Promise<void>) => {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const userLoc: [number, number] = [position.coords.longitude, position.coords.latitude];
        await task(userLoc);
      },
      (error) => {
        alert("Помилка геолокації. Будь ласка, увімкніть GPS або перевірте дозволи.");
        setIsGenerating(false);
        setRouteSummary("");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const handleFilterGeneration = async (filterOptions: RouteFilterOptions) => {
    if (!mapRef.current) return;
    setIsGenerating(true);
    setSidebarOpen(false);
    setRouteSummary("Шукаємо місця та будуємо маршрут...");

    runWithGeolocation(async (userLoc) => {
      try {
        const options: RouteFilterOptions = {
          ...filterOptions,
          destination: filterOptions.routeMode === 'point_to_point'
            ? (destination?.coords ? destination : filterOptions.destination)
            : undefined,
        };
        const generatedRoute = await generateRouteByFilters(userLoc, options);
        loadRouteOnMap(generatedRoute);
      } catch (err: any) {
        alert(err.message || "Помилка побудови маршруту.");
        setRouteSummary("");
      } finally {
        setIsGenerating(false);
      }
    });
  };

  const handleTextGeneration = async (prefs: { prompt: string; routeMode?: string; duration?: number }) => {
    if (!mapRef.current) return;
    setIsGenerating(true);
    setSidebarOpen(false);
    setRouteSummary("Аналізуємо запит...");

    runWithGeolocation(async (userLoc) => {
      try {
        const generatedRoute = await generateRouteFromText(userLoc, prefs.prompt, {
          routeMode: prefs.routeMode as "exploration" | "point_to_point" | undefined,
        });
        loadRouteOnMap(generatedRoute);
      } catch (err: any) {
        alert(err.message || "Помилка побудови маршруту.");
        setRouteSummary("");
      } finally {
        setIsGenerating(false);
      }
    });
  };

  // Прокласти шлях від користувача до точки старту
  const handleNavigateToStart = () => {
    if (!loadedSavedRoute || !mapRef.current) return;
    setIsGenerating(true);
    setRouteSummary("Будуємо шлях до старту маршруту...");

    runWithGeolocation(async (userLoc) => {
      try {
        const fullRoute = await navigateToSavedRoute(userLoc, loadedSavedRoute);
        
        (mapRef.current as any).loadSavedRoute({
          name: loadedSavedRoute.name,
          points: fullRoute.points,
          statistics: { distanceKm: fullRoute.distanceKm, estimatedTimeMinutes: fullRoute.estimatedTimeMinutes },
          waypoints: fullRoute.waypoints,
          steps: fullRoute.steps,
          preferences: loadedSavedRoute.preferences
        });
        
        setIsNavigatingToStart(true);
        setRouteSummary(`Загалом: ${fullRoute.distanceKm} км · ~${fullRoute.estimatedTimeMinutes} хв`);
        setSidebarOpen(true);
      } catch (err: any) {
        alert(err.message || "Помилка побудови маршруту до початку.");
        setRouteSummary("");
      } finally {
        setIsGenerating(false);
      }
    });
  };

  const toggleReselectCategory = (id: string) => {
    setReselectCategories((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  // Знайти нові POI за обраними категоріями та оновити ТОЙ САМИЙ маршрут
  const handleFindNewPOIs = async () => {
    if (!loadedSavedRoute || !mapRef.current) return;
    if (reselectCategories.length === 0) {
      alert("Будь ласка, оберіть хоча б одну категорію.");
      return;
    }

    setIsGenerating(true);
    setRouteSummary("Аналізуємо лінію маршруту та шукаємо нові цікаві місця...");

    try {
      const newWaypoints = await reanalyzeRoutePois(loadedSavedRoute.points, reselectCategories);
      
      const updatedRoute = {
        ...loadedSavedRoute,
        // Замінюємо старі точки на нові
        waypoints: newWaypoints
      };
      
      (mapRef.current as any).loadSavedRoute(updatedRoute);
      setLoadedSavedRoute(updatedRoute);
      setRouteSummary(`Оновлено! Знайдено ${newWaypoints.length} нових місць на маршруті.`);
      setIsEditingPois(false);
    } catch (err: any) {
      alert("Не вдалося знайти нові місця.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRouteSummary = useCallback((sum: string) => {
    setRouteSummary(sum);
    setHasRoute(true);
  }, []);

  const handleClearRoute = () => {
    mapRef.current?.clearCurrentRoute();
    setRouteSummary("");
    setHasRoute(false);
    setLoadedSavedRoute(null);
    setIsNavigatingToStart(false);
    setIsEditingPois(false);
  };

  const handleOpenSaveModal = () => {
    if (!user) {
      alert("Увійдіть у акаунт, щоб зберігати маршрути.");
      navigate("/login");
      return;
    }

    const route = mapRef.current?.getCurrentRoute();
    if (!route?.points?.length) {
      alert("Спочатку згенеруйте маршрут.");
      return;
    }

    setSaveName(getDefaultRouteName(route));
    setSaveDescription("");
    setShowSaveModal(true);
  };

  const handleSaveRoute = async () => {
    const route = mapRef.current?.getCurrentRoute();
    if (!route || !saveName.trim()) return;

    setIsSaving(true);
    try {
      await saveRoute(buildSavedRouteFromResult(route, saveName, saveDescription));
      setShowSaveModal(false);
      alert("Маршрут збережено! Переглянути можна у вкладці Улюблені.");
    } catch (err) {
      console.error(err);
      alert("Не вдалося зберегти маршрут. Спробуйте ще раз.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="container-fluid p-0 position-relative home-layout">
      {isGenerating && (
        <div className="home-generating-overlay" role="status" aria-live="polite">
          <div className="spinner-border text-success" style={{ width: '2.5rem', height: '2.5rem' }} />
          <p>Обробка...</p>
        </div>
      )}

      <div
        className={`home-sidebar-backdrop ${sidebarOpen && !isPickingOnMap ? 'visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />

      <div className="row g-0 h-100">
        <div
          className={`col-12 col-md-4 p-2 p-md-3 bg-light border-end overflow-y-auto home-sidebar ${sidebarOpen ? 'open' : ''} ${isPickingOnMap ? 'd-none' : ''}`}
        >
          <div className="d-flex justify-content-between align-items-center mb-3 d-md-none px-1">
            <h6 className="m-0 fw-bold text-success">
              <i className="bi bi-sliders me-2"></i>Параметри прогулянки
            </h6>
            <button 
              type="button" 
              className="btn-close" 
              aria-label="Закрити" 
              onClick={() => setSidebarOpen(false)}>
            </button>
          </div>

          {loadedSavedRoute ? (
            /* МЕНЮ ДЛЯ ЗБЕРЕЖЕНОГО МАРШРУТУ */
            <div className="card shadow-sm border-0 rounded-4 p-4 bg-white mb-3">
              <h5 className="fw-bold mb-3 text-dark">
                <i className="bi bi-map me-2 text-primary"></i> Збережений маршрут
              </h5>
              <h6 className="text-secondary mb-4">{loadedSavedRoute.name}</h6>
              
              <div className="d-grid gap-3">
                <button 
                  className="btn btn-success py-2.5 rounded-3 shadow-sm fw-medium d-flex justify-content-center align-items-center"
                  onClick={handleNavigateToStart}
                  disabled={isGenerating || isNavigatingToStart}
                >
                  <i className="bi bi-person-walking me-2"></i>
                  {isNavigatingToStart ? "Шлях до старту побудовано" : "Пройтись цим маршрутом"}
                </button>
                
                {!isEditingPois ? (
                  <button 
                    className="btn btn-outline-primary py-2 rounded-3 fw-medium d-flex justify-content-center align-items-center"
                    onClick={() => setIsEditingPois(true)}
                    disabled={isGenerating}
                  >
                    <i className="bi bi-pencil-square me-2"></i>
                    Перевибрати точки інтересу
                  </button>
                ) : (
                  <div className="border rounded-4 p-3 bg-light shadow-sm">
                    <label className="form-label small fw-bold text-secondary text-uppercase mb-2">
                      Що хочеться відвідати?
                    </label>
                    <p className="text-muted small mb-3">
                      Оберіть нові категорії. Ми знайдемо ці місця вздовж збереженого шляху.
                    </p>
                    <div className="d-flex flex-wrap gap-2 mb-4">
                      {AVAILABLE_CATEGORIES.map(cat => {
                        const isSelected = reselectCategories.includes(cat.id);
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => toggleReselectCategory(cat.id)}
                            className={`btn btn-sm rounded-pill px-3 py-1.5 transition-all ${
                              isSelected
                                ? "btn-primary shadow-sm"
                                : "btn-white border text-secondary"
                            }`}
                            style={{ fontSize: "0.85rem", fontWeight: 500 }}
                          >
                            <span className="me-1">{cat.emoji}</span> {cat.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="d-flex gap-2">
                      <button 
                        className="btn btn-primary flex-grow-1 rounded-3 fw-medium" 
                        onClick={handleFindNewPOIs}
                      >
                        <i className="bi bi-search me-1"></i> Знайти
                      </button>
                      <button 
                        className="btn btn-outline-secondary rounded-3" 
                        onClick={() => setIsEditingPois(false)}
                      >
                        Скасувати
                      </button>
                    </div>
                  </div>
                )}
                
                <button 
                  className="btn btn-light text-danger py-2 rounded-3 mt-2 fw-medium border"
                  onClick={handleClearRoute}
                >
                  <i className="bi bi-x-circle me-2"></i>
                  Закрити маршрут
                </button>
              </div>
            </div>
          ) : (
            /* СТАНДАРТНЕ МЕНЮ ГЕНЕРАЦІЇ */
            <>
              <ul className="nav nav-pills nav-fill mb-2 mb-md-3 bg-white p-1 rounded-3 border">
                <li className="nav-item">
                  <button
                    className={`nav-link rounded-2 fw-semibold py-2 ${activeTab === "filters" ? "active bg-success text-white" : "text-secondary"}`}
                    onClick={() => setActiveTab("filters")}
                  >
                    <i className="bi bi-sliders me-1"></i> Фільтри
                  </button>
                </li>
                <li className="nav-item">
                  <button
                    className={`nav-link rounded-2 fw-semibold py-2 ${activeTab === "text" ? "active bg-success text-white" : "text-secondary"}`}
                    onClick={() => setActiveTab("text")}
                  >
                    <i className="bi bi-chat-left-text me-1"></i> Текст
                  </button>
                </li>
              </ul>

              {activeTab === "filters" ? (
                <WalkFiltersMenu
                  onGenerate={handleFilterGeneration}
                  isGenerating={isGenerating}
                  destination={destination}
                  onDestinationChange={setDestination}
                  onPickOnMap={handlePickOnMap}
                />
              ) : (
                <WalkPreferences
                  onGenerate={handleTextGeneration}
                  isGenerating={isGenerating}
                  onRequestGeolocation={() => mapRef.current?.requestGeolocation()}
                  routeSummary={routeSummary}
                  hasRoute={hasRoute}
                  onClearRoute={handleClearRoute}
                />
              )}
            </>
          )}

          {routeSummary && sidebarOpen && (
            <div className="alert alert-info mt-2 mt-md-3 border-0 rounded-3 small shadow-sm mb-2 fw-medium text-center">
              <i className="bi bi-info-circle me-2"></i> {routeSummary}
            </div>
          )}
        </div>

        <div className={`col-12 col-md-8 position-relative h-100 home-map-col ${isPickingOnMap ? 'fullscreen-pick' : ''}`}>
          {!isPickingOnMap && (
            <button
              type="button"
              className={`home-menu-toggle shadow-sm ${sidebarOpen ? 'd-none' : ''} ${!hasOpenedMenu ? 'with-text' : 'icon-only'}`}
              onClick={() => {
                setSidebarOpen(prev => !prev);
                if (!hasOpenedMenu) setHasOpenedMenu(true);
              }}
              aria-label="Меню параметрів"
            >
              <i className="bi bi-signpost-2-fill"></i>
              {!hasOpenedMenu && (
                <span className="ms-2 fs-6 fw-semibold text-dark text-nowrap">
                  Згенерувати прогулянку
                </span>
              )}
            </button>
          )}

          <RouteMap
            ref={mapRef}
            onRouteSummary={handleRouteSummary}
            routeSummary={!sidebarOpen && !isPickingOnMap ? routeSummary : undefined}
            showSaveButton={hasRoute && !isPickingOnMap && !loadedSavedRoute}
            onSaveRoute={handleOpenSaveModal}
            hideMapControls={sidebarOpen || isGenerating || isPickingOnMap}
            pickDestinationMode={isPickingOnMap}
            onDestinationPicked={handleDestinationPicked}
            onPickCancel={handlePickCancel}
          />
        </div>
      </div>

      <Modal show={showSaveModal} onHide={() => setShowSaveModal(false)} centered>
        <Modal.Header closeButton className="border-0 pb-0">
          <Modal.Title className="fw-bold"><i className="bi bi-bookmark-heart text-danger me-2"></i>Зберегти маршрут</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label className="fw-medium text-secondary small">Назва</Form.Label>
            <Form.Control
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Назва маршруту"
              maxLength={120}
              className="rounded-3"
            />
          </Form.Group>
          <Form.Group>
            <Form.Label className="fw-medium text-secondary small">Опис (необовʼязково)</Form.Label>
            <Form.Control
              as="textarea"
              rows={3}
              value={saveDescription}
              onChange={(e) => setSaveDescription(e.target.value)}
              placeholder="Короткий опис прогулянки..."
              maxLength={500}
              className="rounded-3"
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer className="border-0 pt-0">
          <Button variant="light" onClick={() => setShowSaveModal(false)} className="rounded-3 fw-medium text-secondary">
            Скасувати
          </Button>
          <Button
            variant="success"
            onClick={handleSaveRoute}
            disabled={isSaving || !saveName.trim()}
            className="rounded-3 fw-medium px-4"
          >
            {isSaving ? "Збереження..." : "Зберегти маршрут"}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default Home;