import React, { useEffect, useState } from 'react';
import { Bug, Camera, FolderOpen, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  type DebugCapture,
  type Flag,
  type Shows,
  type Stage,
  FLAGS,
  SHOWS,
  STAGES,
  matchStart,
  matchesFor,
  newMatchId,
  scoreboardCoverage,
} from '../services/debugCaptures';
import { Badge, Button, Card, SectionHeader, SegmentedControl } from '../ui';

const TEAM_FLAGS: Flag[] = ['amber', 'sapphire'];
// Scoreboard captures wanted before its reader can be written
const MATCHES_WANTED = 3;

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start gap-2 flex-wrap">
    <span className="text-small text-ink-muted font-semibold w-24 shrink-0 pt-1">{label}</span>
    <div className="flex items-center gap-1.5 flex-wrap min-w-0 flex-1">{children}</div>
  </div>
);

/** Diagnostics: the frames saved with Alt+P, and the form that says what each one shows. */
export const DebugCaptures: React.FC<{ onCapture: () => void; tick: number }> = ({ onCapture, tick }) => {
  const { t } = useI18n();
  const api = window.electronAPI!.debugCaptures;
  const [captures, setCaptures] = useState<DebugCapture[]>([]);
  const [draft, setDraft] = useState<DebugCapture | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const reload = () => api.list().then(setCaptures);
  useEffect(() => {
    void reload();
  }, [tick]);

  const draftId = draft?.id;
  useEffect(() => {
    if (!draftId) return;
    let url: string | null = null;
    let cancelled = false;
    void api.image(draftId).then((bytes) => {
      if (cancelled || !bytes) return;
      url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
      setImageUrl(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setImageUrl(null);
    };
  }, [draftId]);

  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  /** The capture in `matchId`, with that match's team colour unless one is already set. */
  const inMatch = (capture: DebugCapture, matchId: string): DebugCapture => {
    const team = captures.find((c) => c.matchId === matchId && c.id !== capture.id)?.flags.filter((f) => TEAM_FLAGS.includes(f)) ?? [];
    const hasTeam = capture.flags.some((f) => TEAM_FLAGS.includes(f));
    return { ...capture, matchId, flags: hasTeam ? capture.flags : [...capture.flags, ...team] };
  };

  const open = (capture: DebugCapture) =>
    setDraft(capture.matchId ? capture : inMatch(capture, matchesFor(capture, captures)[0] ?? newMatchId(capture)));

  const toggleFlag = (flag: Flag) =>
    setDraft((d) => {
      if (!d) return d;
      if (d.flags.includes(flag)) return { ...d, flags: d.flags.filter((f) => f !== flag) };
      // One team colour at a time
      const kept = TEAM_FLAGS.includes(flag) ? d.flags.filter((f) => !TEAM_FLAGS.includes(f)) : d.flags;
      return { ...d, flags: [...kept, flag] };
    });

  const save = async () => {
    if (!draft) return;
    await api.annotate(draft);
    setDraft(null);
    await reload();
  };

  const remove = async (id: string) => {
    await api.remove(id);
    setDraft(null);
    await reload();
  };

  const coverage = scoreboardCoverage(captures);
  const matchIds = draft ? [...new Set([...matchesFor(draft, captures), newMatchId(draft)])] : [];
  const knownMatches = new Set(captures.filter((c) => c.id !== draft?.id).map((c) => c.matchId));

  return (
    <Card className="p-3.5 space-y-3">
      <SectionHeader
        className="flex-wrap"
        icon={<Bug className="w-4 h-4" />}
        title={t('debug.title')}
        aside={
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={() => api.openFolder()} icon={<FolderOpen className="w-3.5 h-3.5" />}>
              {t('debug.folder')}
            </Button>
            <Button variant="primary" onClick={onCapture} icon={<Camera className="w-3.5 h-3.5" />}>
              {t('debug.capture')}
            </Button>
          </div>
        }
      />
      <p className="text-small text-ink-muted">{t('debug.help')}</p>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-small text-ink-muted font-semibold">{t('debug.coverage')}</span>
        <Badge tone={coverage.matches >= MATCHES_WANTED ? 'good' : 'neutral'}>
          {t('debug.coverage.matches', coverage.matches, MATCHES_WANTED)}
        </Badge>
        {TEAM_FLAGS.map((flag) => (
          <Badge key={flag} tone={coverage[flag as 'amber' | 'sapphire'] ? 'good' : 'neutral'}>
            {t(`debug.flag.${flag}`)}
          </Badge>
        ))}
        {STAGES.map((stage) => (
          <Badge key={stage} tone={coverage.stages.includes(stage) ? 'good' : 'neutral'}>
            {t(`debug.stage.${stage}`)}
          </Badge>
        ))}
        <Badge tone={coverage.dead > 0 ? 'good' : 'neutral'}>{t('debug.coverage.dead', coverage.dead)}</Badge>
      </div>

      {captures.length === 0 && <p className="text-body text-ink-faint">{t('debug.none')}</p>}

      <div className="space-y-1">
        {captures.map((capture) =>
          draft?.id === capture.id ? (
            <div key={capture.id} className="p-2.5 rounded-lg bg-shade/40 border border-accent-500/40 space-y-2.5">
              <div className="aspect-video rounded-lg bg-shade/80 border border-bone/10 overflow-hidden">
                {imageUrl && <img src={imageUrl} alt={capture.id} className="w-full h-full object-contain" />}
              </div>
              <Field label={t('debug.shows')}>
                <SegmentedControl<Shows | ''>
                  size="sm"
                  className="flex-wrap"
                  label={t('debug.shows')}
                  options={SHOWS.map((value) => ({ value, label: t(`debug.shows.${value}`) }))}
                  value={draft.shows ?? ''}
                  onChange={(shows) => setDraft({ ...draft, shows: shows || undefined })}
                />
              </Field>
              <Field label={t('debug.match')}>
                <SegmentedControl<string>
                  size="sm"
                  className="flex-wrap"
                  label={t('debug.match')}
                  options={matchIds.map((value) => ({
                    value,
                    label: knownMatches.has(value) ? t('debug.match.at', time(matchStart(value))) : t('debug.match.new'),
                  }))}
                  value={draft.matchId ?? ''}
                  onChange={(matchId) => setDraft(inMatch(draft, matchId))}
                />
              </Field>
              <Field label={t('debug.stage')}>
                <SegmentedControl<Stage | ''>
                  size="sm"
                  label={t('debug.stage')}
                  options={STAGES.map((value) => ({ value, label: t(`debug.stage.${value}`) }))}
                  value={draft.stage ?? ''}
                  onChange={(stage) => setDraft({ ...draft, stage: stage || undefined })}
                />
              </Field>
              <Field label={t('debug.flags')}>
                {FLAGS.map((flag) => (
                  <Button key={flag} size="sm" pressed={draft.flags.includes(flag)} onClick={() => toggleFlag(flag)}>
                    {t(`debug.flag.${flag}`)}
                  </Button>
                ))}
              </Field>
              <Field label={t('debug.notes')}>
                <textarea
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                  placeholder={t('debug.notesPlaceholder')}
                  aria-label={t('debug.notes')}
                  rows={3}
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-xl bg-shade/40 border border-bone/15 text-body text-ink-strong placeholder:text-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-400"
                />
              </Field>
              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" onClick={() => remove(capture.id)} icon={<Trash2 className="w-3.5 h-3.5" />}>
                  {t('debug.delete')}
                </Button>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    {t('debug.cancel')}
                  </Button>
                  <Button variant="primary" onClick={save}>
                    {t('debug.save')}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <button
              key={capture.id}
              type="button"
              onClick={() => open(capture)}
              className="w-full flex items-center gap-1.5 flex-wrap px-2.5 py-1.5 rounded-lg border border-bone/10 hover:bg-bone/5 text-left text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-400"
            >
              <span className="tabular-nums">{new Date(capture.takenAt).toLocaleString()}</span>
              <span className="text-ink-muted tabular-nums">
                {capture.width}×{capture.height}
              </span>
              {capture.shows || capture.notes ? (
                <>
                  {capture.shows && <Badge tone="info">{t(`debug.shows.${capture.shows}`)}</Badge>}
                  {capture.matchId && <Badge>{t('debug.match.at', time(matchStart(capture.matchId)))}</Badge>}
                  {capture.stage && <Badge>{t(`debug.stage.${capture.stage}`)}</Badge>}
                  {capture.flags.map((flag) => (
                    <Badge key={flag} tone={flag === 'bug' ? 'bad' : 'neutral'}>
                      {t(`debug.flag.${flag}`)}
                    </Badge>
                  ))}
                  {capture.notes && <span className="text-small text-ink-muted truncate min-w-0 flex-1">{capture.notes}</span>}
                </>
              ) : (
                <Badge tone="accent">{t('debug.todo')}</Badge>
              )}
            </button>
          )
        )}
      </div>
    </Card>
  );
};
