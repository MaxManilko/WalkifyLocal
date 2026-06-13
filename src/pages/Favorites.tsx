import { useState, useEffect } from "react";
import { Button, Alert, Spinner, Card, Row, Col, Nav } from "react-bootstrap";
import { useAuth } from "../context/AuthContext";
import { useNavigate } from "react-router-dom";
import * as supabaseModules from "../services/supabaseService";
import MapPreview from "../Components/MapPreview";

interface RouteItem {
  id: string;
  name: string;
  description?: string;
  distance_km?: number;
  statistics?: { distanceKm?: number; estimatedTimeMinutes?: number };
  is_public?: boolean;
  likes_count?: number;
  created_at: string;
  user_id?: string;
  points?: [number, number][];
  waypoints?: any[];
}

const RADIUS_OPTIONS = [10, 25, 50, 100, 200];

function normalizeRouteItem(route: RouteItem & { statistics?: { distanceKm?: number } }): RouteItem {
  return {
    ...route,
    distance_km: route.distance_km ?? route.statistics?.distanceKm ?? 0,
    points: Array.isArray(route.points) ? route.points : [],
  };
}

function Favorites() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [favoriteRoutes, setFavoriteRoutes] = useState<RouteItem[]>([]);
  const [publicRoutes, setPublicRoutes] = useState<RouteItem[]>([]);
  const [myPublishedRoutes, setMyPublishedRoutes] = useState<RouteItem[]>([]);
  const [myRoutes, setMyRoutes] = useState<RouteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "favorites" | "public" | "myPublished" | "myRoutes"
  >("myRoutes");
  const [publishing, setPublishing] = useState(false);
  const [likedRouteIds, setLikedRouteIds] = useState<Set<string>>(new Set());
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [radiusKm, setRadiusKm] = useState(50);
  const [locationError, setLocationError] = useState<string | null>(null);

  const requestUserLocation = () => {
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation([pos.coords.longitude, pos.coords.latitude]);
      },
      () => {
        setLocationError("Не вдалося визначити ваше місцезнаходження");
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
    );
  };

  // Завантажити улюблені маршрути
  useEffect(() => {
    if (!user) return;

    const loadFavorites = async () => {
      try {
        setLoading(true);
        setError(null);
        const routes = await supabaseModules.getFavoriteRoutes(user.id);
        setFavoriteRoutes(routes as unknown as RouteItem[]);
      } catch (err) {
        console.error("Error loading favorites:", err);
        setError("Помилка завантаження улюблених маршрутів");
        setFavoriteRoutes([]);
      } finally {
        setLoading(false);
      }
    };

    loadFavorites();
  }, [user]);

  useEffect(() => {
    if (activeTab === "public" && !userLocation) {
      requestUserLocation();
    }
  }, [activeTab]);

  // Завантажити публічні маршрути (лайки + радіус)
  useEffect(() => {
    if (activeTab !== "public") return;

    const loadPublicRoutes = async () => {
      try {
        setLoading(true);
        setError(null);
        const routes = await supabaseModules.getPublicRoutes({
          userLocation: userLocation ?? undefined,
          radiusKm: userLocation ? radiusKm : undefined,
          limit: 50,
        });
        setPublicRoutes(routes as RouteItem[]);

        if (user) {
          const liked = await supabaseModules.getLikedRouteIds(user.id);
          setLikedRouteIds(liked);
        }
      } catch (err) {
        console.error("Error loading public routes:", err);
        setError("Помилка завантаження публічних маршрутів");
        setPublicRoutes([]);
      } finally {
        setLoading(false);
      }
    };

    loadPublicRoutes();
  }, [activeTab, userLocation, radiusKm, user]);

  // Завантажити мої опубліковані маршрути
  useEffect(() => {
    if (!user) return;

    const loadMyPublished = async () => {
      try {
        setLoading(true);
        setError(null);
        const routes = await supabaseModules.getMyPublishedRoutes();
        setMyPublishedRoutes(routes as unknown as RouteItem[]);
      } catch (err) {
        console.error("Error loading my published routes:", err);
        setError("Помилка завантаження моїх опублікованих маршрутів");
        setMyPublishedRoutes([]);
      } finally {
        setLoading(false);
      }
    };

    loadMyPublished();
  }, [user]);

  // Завантажити всі мої маршрути
  useEffect(() => {
    if (!user) return;

    const loadMyRoutes = async () => {
      try {
        setLoading(true);
        setError(null);
        const routes = await supabaseModules.getUserRoutes(user.id);
        setMyRoutes(routes as unknown as RouteItem[]);
      } catch (err) {
        console.error("Error loading my routes:", err);
        setError("Помилка завантаження моїх маршрутів");
        setMyRoutes([]);
      } finally {
        setLoading(false);
      }
    };

    loadMyRoutes();
  }, [user]);

  const handleRemoveFavorite = async (routeId: string) => {
    if (!user) return;
    try {
      await supabaseModules.removeFromFavorites(routeId);
      setFavoriteRoutes(favoriteRoutes.filter((r) => r.id !== routeId));
    } catch (err) {
      setError("Помилка видалення з улюблених");
      console.error(err);
    }
  };

  const handleAddFavorite = async (routeId: string) => {
    if (!user) return;
    try {
      await supabaseModules.addToFavorites(routeId);
      // Додати маршрут до локального стану, щоб не перезавантажувати зі скрипу
      const routes = await supabaseModules.getFavoriteRoutes(user.id);
      setFavoriteRoutes(routes as unknown as RouteItem[]);
    } catch (err) {
      console.error("Error adding to favorites:", err);
      setError("Помилка додавання в улюблені");
      // Видалимо повідомлення про помилку через 3 секунди
      setTimeout(() => setError(null), 3000);
    }
  };

  const handlePublishRoute = async (routeId: string) => {
    try {
      setPublishing(true);
      await supabaseModules.publishRoute(routeId);
      // Оновити улюблені маршрути
      const routes = await supabaseModules.getFavoriteRoutes(user!.id);
      setFavoriteRoutes(routes as unknown as RouteItem[]);
      // Оновити мої опубліковані маршрути
      const published = await supabaseModules.getMyPublishedRoutes();
      setMyPublishedRoutes(published as unknown as RouteItem[]);
      setError(null);
    } catch (err) {
      console.error("Error publishing route:", err);
      setError("Помилка при публікуванні маршруту");
      setTimeout(() => setError(null), 3000);
    } finally {
      setPublishing(false);
    }
  };

  const handleUnpublishRoute = async (routeId: string) => {
    try {
      setPublishing(true);
      await supabaseModules.unpublishRoute(routeId);
      // Оновити мої опубліковані маршрути
      const published = await supabaseModules.getMyPublishedRoutes();
      setMyPublishedRoutes(published as unknown as RouteItem[]);
      setError(null);
    } catch (err) {
      console.error("Error unpublishing route:", err);
      setError("Помилка при видаленні з публічних");
      setTimeout(() => setError(null), 3000);
    } finally {
      setPublishing(false);
    }
  };

  const handleDeleteRoute = async (routeId: string) => {
    if (!window.confirm("Ви впевнені, що хочете видалити цей маршрут?")) {
      return;
    }

    try {
      setPublishing(true);
      await supabaseModules.deleteRoute(routeId);
      // Оновити список маршрутів
      const routes = await supabaseModules.getUserRoutes(user!.id);
      setMyRoutes(routes as unknown as RouteItem[]);
      setError(null);
      // Успішно видалено
      setTimeout(() => {
        alert("Маршрут успішно видалено");
      }, 500);
    } catch (err) {
      console.error("Error deleting route:", err);
      setError("Помилка при видаленні маршруту");
      setTimeout(() => setError(null), 3000);
    } finally {
      setPublishing(false);
    }
  };

  const handleViewRoute = (route: RouteItem) => {
    const item = normalizeRouteItem(route);
    if (item.points && item.points.length >= 2) {
      localStorage.setItem(
        "routeToView",
        JSON.stringify({
          name: item.name,
          description: item.description,
          points: item.points,
          distance_km: item.distance_km,
          statistics: item.statistics ?? { distanceKm: item.distance_km },
          waypoints: (route as RouteItem & { waypoints?: unknown }).waypoints,
          preferences: (route as RouteItem & { preferences?: unknown }).preferences,
        })
      );
    }
    navigate("/home");
  };

  const handleToggleLike = async (routeId: string) => {
    if (!user) {
      navigate("/login");
      return;
    }

    try {
      const result = await supabaseModules.toggleRouteLike(routeId);
      setLikedRouteIds((prev) => {
        const next = new Set(prev);
        if (result.liked) next.add(routeId);
        else next.delete(routeId);
        return next;
      });
      setPublicRoutes((prev) =>
        prev.map((r) =>
          r.id === routeId ? { ...r, likes_count: result.likesCount } : r
        )
      );
    } catch (err) {
      console.error("Error toggling like:", err);
      setError("Помилка при лайку маршруту");
      setTimeout(() => setError(null), 3000);
    }
  };

  const handleShareRoute = (route: RouteItem) => {
    // Зберегти дані маршруту для шарингу та відкрити чат
    localStorage.setItem(
      "routeToShare",
      JSON.stringify({
        id: route.id,
        name: route.name,
        description: route.description,
        distance_km: route.distance_km,
        points: route.points,
        is_public: route.is_public,
      })
    );
    const params = new URLSearchParams({ shareRoute: "1" });
    navigate(`/chat?${params.toString()}`);
  };

  const renderRouteCard = (
    route: RouteItem,
    isFavorite: boolean,
    isMyPublished: boolean = false,
    isMyRoute: boolean = false,
    showLikes = false
  ) => {
    const item = normalizeRouteItem(route);
    const isLiked = likedRouteIds.has(item.id);
    return (
    <Col md={4} sm={6} xs={12} key={item.id} className="mb-3">
      <Card className="h-100 shadow-sm">
        <MapPreview
          points={item.points}
          isPublic={item.is_public}
          height={200}
        />
        <Card.Body>
          <div className="route-card-title-row mb-1">
            <Card.Title className="text-truncate mb-0 flex-grow-1">{item.name}</Card.Title>
            {showLikes && (
              <span className="badge bg-light text-dark border flex-shrink-0">
                <i className="bi bi-heart-fill text-danger me-1"></i>
                {item.likes_count ?? 0}
              </span>
            )}
          </div>
          <Card.Text className="text-muted small">
            {item.description || "Без опису"}
          </Card.Text>

          <div className="mb-2">
            <small className="text-muted d-block">
              <i className="bi bi-arrows-angle-expand"></i>{" "}
              {(item.distance_km || 0).toFixed(1)} км
            </small>
            <small className="text-muted d-block">
              <i className="bi bi-calendar"></i>{" "}
              {new Date(item.created_at).toLocaleDateString("uk-UA")}
            </small>
            {item.is_public && (
              <small className="badge bg-success">
                <i className="bi bi-globe"></i> Публічний
              </small>
            )}
          </div>

          <div className="route-card-actions">
            {showLikes && (
              <Button
                variant={isLiked ? "danger" : "outline-danger"}
                size="sm"
                onClick={() => handleToggleLike(item.id)}
              >
                <i className={`bi ${isLiked ? "bi-heart-fill" : "bi-heart"} me-1`}></i>
                {isLiked ? "Вам подобається" : "Лайкнути"}
              </Button>
            )}

            <Button
              variant="primary"
              size="sm"
              onClick={() => handleViewRoute(item)}
            >
              <i className="bi bi-map"></i> Переглянути на карті
            </Button>

            <Button
              variant="outline-success"
              size="sm"
              onClick={() => handleShareRoute(item)}
            >
              <i className="bi bi-share"></i> Поділитися в чаті
            </Button>

            {!item.is_public && !isMyPublished && (
              <Button
                variant="success"
                size="sm"
                onClick={() => handlePublishRoute(item.id)}
                disabled={publishing}
              >
                {publishing ? (
                  <>
                    <Spinner
                      as="span"
                      animation="border"
                      size="sm"
                      role="status"
                      aria-hidden="true"
                      className="me-2"
                    />
                    Публікування...
                  </>
                ) : (
                  <>
                    <i className="bi bi-cloud-arrow-up"></i> Опублікувати
                  </>
                )}
              </Button>
            )}

            {isMyPublished ? (
              <Button
                variant="outline-danger"
                size="sm"
                onClick={() => handleUnpublishRoute(item.id)}
                disabled={publishing}
              >
                {publishing ? (
                  <>
                    <Spinner
                      as="span"
                      animation="border"
                      size="sm"
                      role="status"
                      aria-hidden="true"
                      className="me-2"
                    />
                    Видалення...
                  </>
                ) : (
                  <>
                    <i className="bi bi-cloud-arrow-down"></i> З публічних
                  </>
                )}
              </Button>
            ) : isFavorite ? (
              <Button
                variant="outline-danger"
                size="sm"
                onClick={() => handleRemoveFavorite(item.id)}
              >
                <i className="bi bi-heart-fill"></i> З улюблених
              </Button>
            ) : (
              <Button
                variant="outline-success"
                size="sm"
                onClick={() => handleAddFavorite(item.id)}
              >
                <i className="bi bi-heart"></i> Улюблені
              </Button>
            )}

            {isMyRoute && (
              <Button
                variant="outline-danger"
                size="sm"
                onClick={() => handleDeleteRoute(item.id)}
                disabled={publishing}
              >
                {publishing ? (
                  <>
                    <Spinner
                      as="span"
                      animation="border"
                      size="sm"
                      role="status"
                      aria-hidden="true"
                      className="me-2"
                    />
                    Видалення...
                  </>
                ) : (
                  <>
                    <i className="bi bi-trash"></i> Видалити
                  </>
                )}
              </Button>
            )}
          </div>
        </Card.Body>
      </Card>
    </Col>
  );
  };

  if (!user) {
    return (
      <div className="px-3">
        <Alert variant="info" className="mt-3">
          <Alert.Heading>
            <i className="bi bi-info-circle me-2"></i>
            Потрібна авторизація
          </Alert.Heading>
          <p>Для перегляду маршрутів потрібно увійти у свій аккаунт.</p>
        </Alert>
      </div>
    );
  }

  return (
    <div className="favorites-page">
      <h1 className="mb-4">
        <i className="bi bi-heart-fill text-danger me-2"></i>
        Маршрути
      </h1>

      {error && <Alert variant="danger">{error}</Alert>}

      <Nav variant="tabs" className="mb-4 favorites-nav">
        {user && (
          <Nav.Item>
            <Nav.Link
              active={activeTab === "myRoutes"}
              onClick={() => setActiveTab("myRoutes")}
            >
              <i className="bi bi-bookmark me-2"></i>
              Мої маршрути 
            </Nav.Link>
          </Nav.Item>
        )}
        <Nav.Item>
          <Nav.Link
            active={activeTab === "favorites"}
            onClick={() => setActiveTab("favorites")}
          >
            <i className="bi bi-heart me-2"></i>
            Улюблені 
          </Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link
            active={activeTab === "public"}
            onClick={() => setActiveTab("public")}
          >
            <i className="bi bi-globe me-2"></i>
            Публічні 
          </Nav.Link>
        </Nav.Item>
        {user && (
          <Nav.Item>
            <Nav.Link
              active={activeTab === "myPublished"}
              onClick={() => setActiveTab("myPublished")}
            >
              <i className="bi bi-cloud-check me-2"></i>
              Мої опубліковані 
            </Nav.Link>
          </Nav.Item>
        )}
      </Nav>

      {loading ? (
        <div className="text-center">
          <Spinner animation="border" variant="success" />
        </div>
      ) : activeTab === "myRoutes" ? (
        <>
          {myRoutes.length === 0 ? (
            <Alert variant="info">
              <i className="bi bi-info-circle me-2"></i>У вас поки немає
              збережених маршрутів.
            </Alert>
          ) : (
            <Row>
              {myRoutes.map((route) =>
                renderRouteCard(route, false, false, true)
              )}
            </Row>
          )}
        </>
      ) : activeTab === "favorites" ? (
        <>
          {favoriteRoutes.length === 0 ? (
            <Alert variant="info">
              <i className="bi bi-info-circle me-2"></i>У вас поки немає
              улюблених маршрутів.
            </Alert>
          ) : (
            <Row>
              {favoriteRoutes.map((route) => renderRouteCard(route, true))}
            </Row>
          )}
        </>
      ) : activeTab === "public" ? (
        <>
          <Card className="mb-3 border-0 shadow-sm public-routes-filter">
            <Card.Body className="py-3">
              <Row className="g-3 align-items-end">
                <Col xs={12} sm={6} md={4} lg={3}>
                  <label className="form-label small fw-semibold mb-1">
                    Радіус від вас
                  </label>
                  <select
                    className="form-select form-select-sm"
                    value={radiusKm}
                    onChange={(e) => setRadiusKm(Number(e.target.value))}
                    disabled={!userLocation}
                  >
                    {RADIUS_OPTIONS.map((km) => (
                      <option key={km} value={km}>
                        {km} км
                      </option>
                    ))}
                  </select>
                </Col>
                <Col xs={12} sm="auto">
                  <Button
                    variant="outline-success"
                    size="sm"
                    className="w-100 w-sm-auto"
                    onClick={requestUserLocation}
                  >
                    <i className="bi bi-crosshair me-1"></i>
                    Моя локація
                  </Button>
                </Col>
                <Col xs={12} md>
                  <p className="filter-hint text-muted">
                    {userLocation
                      ? "Список відсортовано за лайками поруч із вами"
                      : "Увімкніть геолокацію для фільтра за відстанню"}
                  </p>
                </Col>
              </Row>
              {locationError && (
                <Alert variant="warning" className="mt-2 mb-0 py-2 small">
                  {locationError}
                </Alert>
              )}
            </Card.Body>
          </Card>

          {publicRoutes.length === 0 ? (
            <Alert variant="info">
              <i className="bi bi-info-circle me-2"></i>
              {userLocation
                ? `Публічних маршрутів у радіусі ${radiusKm} км не знайдено.`
                : "Публічних маршрутів поки немає."}
            </Alert>
          ) : (
            <Row>
              {publicRoutes.map((route) => renderRouteCard(route, false, false, false, true))}
            </Row>
          )}
        </>
      ) : (
        <>
          {myPublishedRoutes.length === 0 ? (
            <Alert variant="info">
              <i className="bi bi-info-circle me-2"></i>
              Ви поки не опублікували жодного маршруту.
            </Alert>
          ) : (
            <Row>
              {myPublishedRoutes.map((route) =>
                renderRouteCard(route, false, true)
              )}
            </Row>
          )}
        </>
      )}
    </div>
  );
}

export default Favorites;
