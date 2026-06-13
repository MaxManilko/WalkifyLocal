import React, { useEffect, useState } from "react";
import { RouteWaypoint } from "../services/routeService";
import { getPlaceDetails, PlaceDetails, CATEGORY_LABELS } from "../services/placesService";

interface PlaceInfoCardProps {
  waypoint: RouteWaypoint;
  stopNumber?: number;
  onClose: () => void;
}

const PRICE_LABELS = ['', 'Дешево', 'Помірно', 'Дорого', 'Дуже дорого'];

const PlaceInfoCard: React.FC<PlaceInfoCardProps> = ({ waypoint, stopNumber, onClose }) => {
  const [details, setDetails] = useState<PlaceDetails | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!waypoint.externalId) return;
    setLoading(true);
    getPlaceDetails(waypoint.externalId)
      .then(setDetails)
      .finally(() => setLoading(false));
  }, [waypoint.externalId]);

  const catInfo = CATEGORY_LABELS[waypoint.type] || CATEGORY_LABELS.custom;
  const rating = details?.rating ?? waypoint.rating;
  const reviewCount = details?.userRatingsTotal ?? waypoint.userRatingsTotal;
  const photoUrl = details?.photoUrl ?? waypoint.photoUrl;
  const address = details?.address ?? waypoint.address;

  return (
    <div
      className="card shadow-lg border-0 rounded-4 overflow-hidden place-info-card d-flex flex-column"
      style={{ 
        position: 'fixed', 
        bottom: 120, /* Піднято високо над навігаційним меню! */
        left: '50%', 
        transform: 'translateX(-50%)', 
        zIndex: 1300, 
        width: 'min(380px, calc(100vw - 32px))',
        maxHeight: '60vh' /* Картка не буде займати більше 60% висоти екрану */
      }}
    >
      {/* Блок з фотографією (завжди фіксований зверху картки) */}
      {photoUrl && (
        <div className="flex-shrink-0" style={{ height: 160, background: '#e9ecef', position: 'relative' }}>
          <img src={photoUrl} alt={waypoint.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <button
            type="button"
            className="btn btn-light btn-sm rounded-circle position-absolute shadow-sm"
            style={{ top: 8, right: 8, width: 32, height: 32, padding: 0 }}
            onClick={onClose}
          >
            <i className="bi bi-x-lg"></i>
          </button>
        </div>
      )}

      {/* Тіло картки з прокруткою (якщо контенту забагато) */}
      <div className="card-body p-3 overflow-y-auto">
        {!photoUrl && (
          <div className="d-flex justify-content-between align-items-start mb-2">
            <span className="fs-4">{catInfo.emoji}</span>
            <button type="button" className="btn-close shadow-none" onClick={onClose}></button>
          </div>
        )}

        {stopNumber !== undefined && (
          <span className="badge bg-success-subtle text-success mb-2">Зупинка {stopNumber}</span>
        )}

        <h6 className="fw-bold mb-1">{details?.name ?? waypoint.name}</h6>

        <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
          {rating !== undefined && (
            <span className="small fw-semibold text-warning">
              ★ {rating.toFixed(1)}
              {reviewCount !== undefined && (
                <span className="text-muted fw-normal"> ({reviewCount.toLocaleString()})</span>
              )}
            </span>
          )}
          <span className="badge bg-light text-secondary border small">
            {catInfo.emoji} {catInfo.label}
          </span>
          {details?.priceLevel !== undefined && details.priceLevel > 0 && (
            <span className="small text-muted">{PRICE_LABELS[details.priceLevel]}</span>
          )}
        </div>

        {address && (
          <p className="small text-muted mb-2">
            <i className="bi bi-geo-alt me-1"></i>{address}
          </p>
        )}

        {details?.isOpen !== undefined && (
          <p className={`small mb-2 fw-semibold ${details.isOpen ? 'text-success' : 'text-danger'}`}>
            {details.isOpen ? '● Відкрито зараз' : '● Зачинено зараз'}
          </p>
        )}

        {details?.openingHours && details.openingHours.length > 0 && (
          <div className="small text-muted mb-2">
            {details.openingHours.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}

        {details?.phone && (
          <p className="small mb-0">
            <i className="bi bi-telephone me-1 text-secondary"></i>{details.phone}
          </p>
        )}

        {loading && (
          <div className="text-center py-2">
            <span className="spinner-border spinner-border-sm text-success"></span>
          </div>
        )}
      </div>
    </div>
  );
};

export default PlaceInfoCard;