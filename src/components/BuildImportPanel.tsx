import React, { useState } from 'react';
import { Download, RefreshCw, Search, Trash2 } from 'lucide-react';
import { ITEMS_DB, getHeroApiId, getItemIdByApiId } from '../data/deadlockData';
import { useI18n } from '../i18n';
import { ApiHeroBuild, ImportedBuild, fetchApiBuilds, isBuildCode, parseHeroBuild, phasesFromApiBuild } from '../services/importedBuild';
import { Button } from '../ui';

interface Props {
  heroId: string;
  imported?: ImportedBuild;
  /** A build imported (or updated), or null when removed */
  onChange: (build: ImportedBuild | null) => void;
}

const toImported = (heroId: string, build: ApiHeroBuild, pasted: boolean): ImportedBuild => ({
  heroId,
  ...(pasted && { pasted }),
  buildId: build.hero_build_id,
  version: build.version,
  name: String(build.name ?? '').trim().slice(0, 80) || `#${build.hero_build_id}`,
  phases: phasesFromApiBuild(build, getItemIdByApiId, (id) => ITEMS_DB[id]?.cost ?? 0),
});

/**
 * Import a published build of my hero from deadlock-api.com (by its id, or by searching its name), or a build code
 * copied in the game. Main window only.
 */
export const BuildImportPanel: React.FC<Props> = ({ heroId, imported, onChange }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ApiHeroBuild[] | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const heroApiId = getHeroApiId(heroId);

  const run = async (task: () => Promise<void>) => {
    setStatus('loading');
    setMessage('');
    try {
      await task();
      setStatus('idle');
    } catch (error) {
      setStatus('error');
      setMessage(t('import.failed', error instanceof Error ? error.message : String(error)));
    }
  };

  const search = () =>
    run(async () => {
      if (heroApiId === undefined) throw new Error(t('import.unknownHero'));
      if (isBuildCode(query)) {
        const bytes = await window.electronAPI?.decodeBuildCode(query);
        let build: ApiHeroBuild;
        try {
          if (!bytes) throw new Error();
          build = parseHeroBuild(bytes);
        } catch {
          throw new Error(t('import.badCode'));
        }
        choose(build, true);
        return;
      }
      const text = query.trim().replace(/^#/, '');
      const builds = /^\d+$/.test(text)
        ? await fetchApiBuilds({ buildId: Number(text) })
        : await fetchApiBuilds({ heroApiId, search: text });
      setResults(builds);
    });

  // Throws, so that run() shows the error: a status set here was reset to idle by run() right after
  const choose = (build: ApiHeroBuild, pasted = false) => {
    if (build.hero_id !== heroApiId) throw new Error(t('import.otherHero'));
    const next = toImported(heroId, build, pasted);
    if (next.phases.early.length + next.phases.mid.length + next.phases.late.length === 0) throw new Error(t('import.empty'));
    onChange(next);
    setResults(null);
    if (pasted) setQuery('');
  };

  const update = () =>
    run(async () => {
      if (!imported) return;
      const [build] = await fetchApiBuilds({ buildId: imported.buildId });
      if (!build) throw new Error(t('import.gone'));
      choose(build);
    });

  return (
    <div className="space-y-2">
      {imported && (
        <div className="flex items-center gap-2 p-2 rounded-xl bg-shade/40 border border-bone/10">
          <div className="min-w-0 flex-1">
            <p className="font-label text-body text-ink-strong truncate">{imported.name}</p>
            <p className="text-small text-ink-muted">
              {imported.pasted ? t('import.pastedSubtitle') : t('import.subtitle', imported.buildId, imported.version)}
            </p>
          </div>
          {!imported.pasted && (
            <Button size="sm" variant="ghost" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={update} disabled={status === 'loading'}>
              {t('import.update')}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => onChange(null)}>
            {t('import.remove')}
          </Button>
        </div>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('import.placeholder')}
          aria-label={t('import.placeholder')}
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-xl bg-shade/40 border border-bone/15 text-body text-ink-strong placeholder:text-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-400"
        />
        <Button type="submit" size="sm" variant="primary" icon={<Search className="w-3.5 h-3.5" />} disabled={status === 'loading'}>
          {t('import.search')}
        </Button>
      </form>
      <p className="text-small text-ink-muted">{t('import.help')}</p>
      {status === 'loading' && <p className="text-small text-ink-soft">{t('import.loading')}</p>}
      {status === 'error' && <p className="text-small text-bad-300">{message}</p>}
      {results && results.length === 0 && <p className="text-small text-ink-soft">{t('import.none')}</p>}
      {results && results.length > 0 && (
        <ul className="space-y-1 max-h-72 overflow-y-auto">
          {results.map((build) => (
            <li key={build.hero_build_id} className="flex items-center gap-2 p-1.5 rounded-xl bg-shade/40 border border-bone/5">
              <div className="min-w-0 flex-1">
                <p className="text-body text-ink-strong truncate">{build.name}</p>
                <p className="text-small text-ink-muted">{t('import.subtitle', build.hero_build_id, build.version)}</p>
              </div>
              <Button size="sm" variant="secondary" icon={<Download className="w-3.5 h-3.5" />} onClick={() => run(async () => choose(build))}>
                {t('import.use')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
