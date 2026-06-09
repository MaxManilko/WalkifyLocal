import React, { useState, useRef, useCallback, useEffect } from "react";
import { Modal, Button, Form } from "react-bootstrap";
import { useNavigate } from "react-router-dom";
import RouteMap, { RouteMapRef } from "../Components/RouteMap";
import WalkPreferences from "../Components/WalkPreferences";
import WalkFiltersMenu from "../Components/WalkFiltersMenu";
import { generateRouteByFilters, generateRouteFromText, RouteFilterOptions, RouteDestination } from "../services/routeService";
import { useAuth } from "../context/AuthContext";
import { saveRoute } from "../services/supabaseService";
import { buildSavedRouteFromResult, getDefaultRouteName } from "../utils/routeSave";
import "../styles/home.css";

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
  const [hasOpenedMenu, setHasOpenedMenu] = useState(false); // Стан для відслідковування першого відкриття
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDescription, setSaveDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isActive) return;
    const frameId = requestAnimationFrame(() => {
      mapRef.current?.refreshMapLayout();
    });
    return () => cancelAnimationFrame(frameId);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    const raw = localStorage.getItem("routeToView");
    if (!raw) return;

    try {
      const data = JSON.parse(raw);
      if (!data.points?.length || !mapRef.current) return;

      mapRef.current.loadSavedRoute({
        name: data.name || "Збережений маршрут",
        description: data.description,
        points: data.points,
        statistics: {
          distanceKm: data.distance_km ?? data.statistics?.distanceKm ?? 0,
          estimatedTimeMinutes: data.statistics?.estimatedTimeMinutes ?? 0,
        },
        waypoints: data.waypoints || [],
        preferences: data.preferences,
      });
      setHasRoute(true);
      if (data.distance_km || data.statistics?.distanceKm) {
        const km = data.distance_km ?? data.statistics?.distanceKm;
        const min = data.statistics?.estimatedTimeMinutes;
        setRouteSummary(min ? `${km} км · ~${min} хв` : `${km} км`);
      }
    } catch (err) {
      console.error("routeToView:", err);
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

  const runWithGeolocation = (task: (userLoc: [number, number]) => Promise<void>) => {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const userLoc: [number, number] = [position.coords.longitude, position.coords.latitude];
        await task(userLoc);
      },
      () => {
        alert("Будь ласка, увімкніть геолокацію в браузері.");
        setIsGenerating(false);
        setRouteSummary("");
      }
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

  const handleRouteSummary = useCallback((sum: string) => {
    setRouteSummary(sum);
    setHasRoute(true);
  }, []);

  const handleClearRoute = () => {
    mapRef.current?.clearCurrentRoute();
    setRouteSummary("");
    setHasRoute(false);
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
      alert("Маршрут збережено! Переглянути можна у вкладці Routes.");
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
          <p>Будуємо маршрут...</p>
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
          {/* Шапка сайдбару з кнопкою закриття для мобільних пристроїв */}
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

          {routeSummary && sidebarOpen && (
            <div className="alert alert-info mt-2 mt-md-3 border-0 rounded-3 small shadow-sm mb-2">
              <i className="bi bi-info-circle me-2"></i> {routeSummary}
            </div>
          )}

        </div>

        <div className={`col-12 col-md-8 position-relative h-100 home-map-col ${isPickingOnMap ? 'fullscreen-pick' : ''}`}>
          {/* Нова динамічна кнопка відкриття меню */}
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
            showSaveButton={hasRoute && !isPickingOnMap}
            onSaveRoute={handleOpenSaveModal}
            pickDestinationMode={isPickingOnMap}
            onDestinationPicked={handleDestinationPicked}
            onPickCancel={handlePickCancel}
          />
        </div>
      </div>

      <Modal show={showSaveModal} onHide={() => setShowSaveModal(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title>Зберегти маршрут</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label>Назва</Form.Label>
            <Form.Control
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Назва маршруту"
              maxLength={120}
            />
          </Form.Group>
          <Form.Group>
            <Form.Label>Опис (необовʼязково)</Form.Label>
            <Form.Control
              as="textarea"
              rows={2}
              value={saveDescription}
              onChange={(e) => setSaveDescription(e.target.value)}
              placeholder="Короткий опис прогулянки"
              maxLength={500}
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setShowSaveModal(false)}>
            Скасувати
          </Button>
          <Button
            variant="success"
            onClick={handleSaveRoute}
            disabled={isSaving || !saveName.trim()}
          >
            {isSaving ? "Збереження..." : "Зберегти"}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default Home;