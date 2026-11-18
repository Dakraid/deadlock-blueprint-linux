import React from 'react';
import { Camera, FolderOpen, LifeBuoy, MonitorUp, Terminal } from 'lucide-react';
import { useI18n } from '../i18n';
import type { CaptureState } from '../services/screenCapture';
import type { VisionDetectionResult } from '../services/visionScanner';
import { isSupportedFormat } from '../services/matchTracker';
import type { DeadlockHero } from '../data/deadlockData';
import { Button, Card, SectionHeader } from '../ui';
import { DebugCaptures } from './DebugCaptures';

interface DiagnosticsTabProps {
  heroes: DeadlockHero[];
  captureState: CaptureState;
  onChooseCapture: () => void;
  onScanNow: () => void;
  onReport: () => void;
  lastCaptureUrl: string | null;
  lastDetection: VisionDetectionResult | null;
  onDebugCapture: () => void;
  /** Changes when a debug capture was saved */
  debugCaptureTick: number;
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start justify-between gap-3 py-1 border-b border-bone/5 text-body">
    <span className="text-ink-muted shrink-0">{label}</span>
    <span className="text-ink text-right break-words min-w-0 tabular-nums">{children}</span>
  </div>
);

const Preview: React.FC<{ src?: string | null; alt: string; empty: string }> = ({ src, alt, empty }) => (
  <div className="aspect-video rounded-lg bg-shade/80 border border-bone/10 overflow-hidden flex items-center justify-center">
    {src ? <img src={src} alt={alt} className="w-full h-full object-contain" /> : <span className="text-body text-ink-faint">{empty}</span>}
  </div>
);

/** What the scanner sees, live while this tab is open (previews, portraits, inventory slots, raw logs). */
export const DiagnosticsTab: React.FC<DiagnosticsTabProps> = ({
  heroes,
  captureState,
  onChooseCapture,
  onScanNow,
  onReport,
  lastCaptureUrl,
  lastDetection,
  onDebugCapture,
  debugCaptureTick,
}) => {
  const { t } = useI18n();
  const heroName = (id: string | null | undefined) => (id ? heroes.find((h) => h.id === id)?.name ?? id : '?');
  const d = lastDetection;
  const slotsLine = (slots: (string | null)[] | undefined, mine = -1) =>
    slots ? slots.map((id, i) => `${i + 1}:${heroName(id)}${i === mine ? '★' : ''}`).join('  ') : '—';

  return (
    <div className="space-y-3">
      <Card className="p-3.5 border-accent-500/40 space-y-3">
        <SectionHeader
          className="flex-wrap"
          icon={<Terminal className="w-4 h-4" />}
          title={t('diag.title')}
          aside={
            <div className="flex items-center gap-2 flex-wrap">
              {window.electronAPI && (
                <Button
                  onClick={() => window.electronAPI?.matchLog.openFolder()}
                  title={t('diag.logsTitle')}
                  icon={<FolderOpen className="w-3.5 h-3.5" />}
                >
                  {t('diag.logsButton')}
                </Button>
              )}
              <Button onClick={onReport} icon={<LifeBuoy className="w-3.5 h-3.5" />}>
                {t('diag.reportButton')}
              </Button>
              <Button variant="primary" onClick={onScanNow} icon={<Camera className="w-3.5 h-3.5" />}>
                {t('diag.scanNow')}
              </Button>
            </div>
          }
        />

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-small text-ink-muted font-semibold">{t('diag.target')}</span>
          <span className="text-body text-ink">{t(`capture.state.${captureState}`)}</span>
          <Button
            onClick={onChooseCapture}
            icon={<MonitorUp className="w-3.5 h-3.5" />}
          >
            {t('capture.choose')}
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Preview src={lastCaptureUrl} alt={t('diag.captured')} empty={t('diag.noScan')} />
          <Preview src={d?.hudPreviewUrl} alt={t('diag.hud')} empty={t('diag.waiting')} />
        </div>

        {d && (
          <div className="space-y-0.5">
            <Row label={t('diag.source')}>{d.sourceName}</Row>
            <Row label={t('diag.frame')}>
              <span className={isSupportedFormat(d.frameWidth, d.frameHeight) ? 'text-good-300' : 'text-bad-300 font-bold'}>
                {d.frameWidth}×{d.frameHeight}
              </span>
            </Row>
            <Row label={t('diag.mode')}>
              {d.shopOpen ? t('diag.mode.shop') : d.hudVisible ? t('diag.mode.hud') : t('diag.mode.other')}
            </Row>
            <Row label={t('diag.allies')}>{slotsLine(d.allySlots, d.mySlotIndex)}</Row>
            <Row label={t('diag.enemies')}>{slotsLine(d.enemySlots)}</Row>
            <Row label={t('diag.inventory')}>
              {(d.inventorySlots ?? [])
                .map((s) =>
                  s.state === 'empty' ? '·' : s.state === 'locked' ? '🔒' : s.state === 'unknown' ? `?${s.category ?? ''}` : `${s.state === 'cooldown' ? '⏳' : ''}${s.itemId}`
                )
                .join('  ')}
            </Row>
            {d.detectedSouls !== undefined && <Row label={t('souls.unit')}>{d.detectedSouls}</Row>}
            <details className="pt-1">
              <summary className="text-small text-ink-muted cursor-pointer">{t('diag.details')}</summary>
              <pre className="mt-1 max-h-64 overflow-y-auto text-small leading-snug text-ink-muted whitespace-pre-wrap">
                {d.debugLogs.join('\n')}
              </pre>
            </details>
          </div>
        )}
      </Card>
      {window.electronAPI && <DebugCaptures onCapture={onDebugCapture} tick={debugCaptureTick} />}
    </div>
  );
};
