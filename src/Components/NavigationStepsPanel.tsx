import React, { useState } from "react";
import { RouteStep } from "../services/routeService";

interface NavigationStepsPanelProps {
  steps: RouteStep[];
  currentStepIndex: number;
  remainingDistanceMeters?: number;
  remainingDurationSeconds?: number;
  onStepClick?: (index: number) => void;
}

const MANEUVER_ICON: Record<string, string> = {
  'turn-left': '↰', 'turn-right': '↱', 'turn-slight-left': '↖', 'turn-slight-right': '↗',
  'turn-sharp-left': '⤺', 'turn-sharp-right': '⤻', 'uturn-left': '↩', 'uturn-right': '↪',
  'straight': '↑', 'ramp-left': '↰', 'ramp-right': '↱', 'fork-left': '↰', 'fork-right': '↱',
  'roundabout-left': '↺', 'roundabout-right': '↻', 'merge': '↑',
};

function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} м`;
  return `${(meters / 1000).toFixed(1)} км`;
}

const NavigationStepsPanel: React.FC<NavigationStepsPanelProps> = ({
  steps,
  currentStepIndex,
  remainingDistanceMeters,
  remainingDurationSeconds,
  onStepClick,
}) => {
  const [expanded, setExpanded] = useState(true);

  if (steps.length === 0) return null;

  const current = steps[Math.min(currentStepIndex, steps.length - 1)];
  const next = steps[currentStepIndex + 1];
  const icon = current.maneuver ? (MANEUVER_ICON[current.maneuver] || '→') : '→';
  const showRemaining = remainingDistanceMeters !== undefined;
  const displayDistance = showRemaining ? remainingDistanceMeters! : current.distanceMeters;
  const displayDuration = showRemaining
    ? (remainingDurationSeconds ?? 0)
    : current.durationSeconds;

  if (!expanded) {
    return (
      <button
        type="button"
        className="navigation-panel navigation-panel-mini btn btn-success shadow rounded-pill px-3 py-2 small fw-semibold"
        onClick={() => setExpanded(true)}
      >
        <i className="bi bi-signpost-split me-1"></i>
        Крок {Math.min(currentStepIndex + 1, steps.length)}/{steps.length}
      </button>
    );
  }

  return (
    <div className="navigation-panel navigation-panel-expanded shadow-lg border-0 rounded-4 overflow-hidden bg-white">
      <div className="bg-success text-white px-3 py-2 small fw-semibold d-flex align-items-center gap-2">
        <i className="bi bi-signpost-split"></i>
        <span className="text-truncate">Покрокова навігація</span>
        <span className="badge bg-white text-success ms-auto">
          {Math.min(currentStepIndex + 1, steps.length)}/{steps.length}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-link text-white p-0 ms-1"
          onClick={() => setExpanded(false)}
          aria-label="Згорнути"
        >
          <i className="bi bi-chevron-down"></i>
        </button>
      </div>

      <div className="p-3">
        <div className="d-flex gap-2 align-items-start">
          <div
            className="flex-shrink-0 d-flex align-items-center justify-content-center rounded-3 bg-success-subtle text-success fw-bold"
            style={{ width: 40, height: 40, fontSize: '1.25rem' }}
          >
            {icon}
          </div>
          <div className="flex-grow-1 min-w-0">
            <div className="fw-bold text-dark small">{current.instruction}</div>
            <div className="text-muted" style={{ fontSize: '0.75rem' }}>
              {showRemaining && <span className="text-success fw-semibold">залишилось </span>}
              {formatDistance(displayDistance)}
              {displayDuration > 0 && ` · ~${Math.max(1, Math.round(displayDuration / 60))} хв`}
            </div>
          </div>
        </div>

        {next && (
          <div className="mt-2 pt-2 border-top text-muted" style={{ fontSize: '0.75rem' }}>
            <span className="fw-semibold">Далі: </span>{next.instruction}
          </div>
        )}
      </div>

      <details className="border-top">
        <summary className="px-3 py-2 text-secondary user-select-none" style={{ fontSize: '0.75rem' }}>
          Усі кроки ({steps.length})
        </summary>
        <div className="nav-steps-list">
          {steps.map((step, i) => (
            <button
              key={i}
              type="button"
              className={`w-100 text-start border-0 px-3 py-2 ${
                i === currentStepIndex ? 'bg-success-subtle fw-semibold' : 'bg-white'
              } ${i < currentStepIndex ? 'text-muted' : ''}`}
              style={{ fontSize: '0.75rem' }}
              onClick={() => onStepClick?.(i)}
            >
              <span className="me-1 text-success">{i + 1}.</span>
              {step.instruction}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
};

export default NavigationStepsPanel;
