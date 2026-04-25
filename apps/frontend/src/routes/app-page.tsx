import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Deployment } from '@updraft/shared-types';
import { createDeployment, listDeployments } from '../lib/api';
import { LogViewer } from '../components/log-viewer';

type SourceMode = 'git' | 'upload';

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function AppPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<SourceMode>('git');
  const [gitUrl, setGitUrl] = useState('');
  const [archive, setArchive] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment | null>(null);

  const deploymentsQuery = useQuery({
    queryKey: ['deployments'],
    queryFn: listDeployments,
    refetchInterval: 3000,
  });

  const createMutation = useMutation({
    mutationFn: createDeployment,
    onSuccess: async () => {
      setGitUrl('');
      setArchive(null);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
  });

  const submitLabel = useMemo(() => {
    if (createMutation.isPending) {
      return mode === 'git' ? 'Queueing repo...' : 'Uploading archive...';
    }
    return mode === 'git' ? 'Deploy from Git' : 'Deploy uploaded archive';
  }, [createMutation.isPending, mode]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    if (mode === 'git') {
      if (!gitUrl.trim()) {
        setFormError('Enter a Git repository URL.');
        return;
      }
      await createMutation.mutateAsync({ mode: 'git', gitUrl: gitUrl.trim() }).catch((error: unknown) => {
        setFormError(error instanceof Error ? error.message : 'Failed to queue deployment');
      });
      return;
    }

    if (!archive) {
      setFormError('Choose a project archive to upload.');
      return;
    }

    await createMutation.mutateAsync({ mode: 'upload', archive }).catch((error: unknown) => {
      setFormError(error instanceof Error ? error.message : 'Failed to queue deployment');
    });
  };

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">One-page deployment console</p>
          <h1>Ship a repo or archive into the local pipeline.</h1>
          <p className="hero-text">
            Choose a source, submit a deployment, and watch logs stream live.
          </p>
        </div>
      </section>

      <section className="app-grid">
        <section className="panel">
          <div className="panel-header">
            <h2>Create deployment</h2>
            <p>Start from a Git URL or upload a tarball/zip for extraction.</p>
          </div>

          <form className="deployment-form" onSubmit={handleSubmit}>
            <div className="mode-toggle" role="tablist" aria-label="Deployment source">
              <button
                type="button"
                className={mode === 'git' ? 'toggle-button active' : 'toggle-button'}
                onClick={() => setMode('git')}
              >
                Git URL
              </button>
              <button
                type="button"
                className={mode === 'upload' ? 'toggle-button active' : 'toggle-button'}
                onClick={() => setMode('upload')}
              >
                Upload archive
              </button>
            </div>

            {mode === 'git' ? (
              <label className="field">
                <span>Repository URL</span>
                <input
                  type="url"
                  name="gitUrl"
                  placeholder="https://github.com/owner/repo"
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                />
              </label>
            ) : (
              <label className="field">
                <span>Project archive</span>
                <input
                  type="file"
                  name="archive"
                  accept=".tar,.tar.gz,.tgz,.zip"
                  onChange={(event) => setArchive(event.target.files?.[0] ?? null)}
                />
              </label>
            )}

            {(formError || createMutation.error) ? (
              <p className="form-message error">
                {formError ?? createMutation.error?.message}
              </p>
            ) : null}

            {createMutation.isSuccess ? (
              <p className="form-message success">Deployment queued successfully.</p>
            ) : null}

            <button type="submit" className="submit-button" disabled={createMutation.isPending}>
              {submitLabel}
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Recent deployments</h2>
            <p>Click a row to view live logs. Updates every 3 seconds.</p>
          </div>

          {deploymentsQuery.isLoading ? <p className="empty-state">Loading deployments...</p> : null}
          {deploymentsQuery.isError ? (
            <p className="empty-state error">{deploymentsQuery.error.message}</p>
          ) : null}

          {!deploymentsQuery.isLoading && !deploymentsQuery.isError ? (
            deploymentsQuery.data && deploymentsQuery.data.length > 0 ? (
              <ul className="deployment-list">
                {deploymentsQuery.data.map((deployment) => (
                  <li
                    key={deployment.id}
                    className={`deployment-row${selectedDeployment?.id === deployment.id ? ' deployment-row--selected' : ''}`}
                    onClick={() => setSelectedDeployment(deployment)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setSelectedDeployment(deployment)}
                  >
                    <div>
                      <p className="deployment-id">{deployment.id}</p>
                      <p className="deployment-source">{deployment.source_ref}</p>
                      {deployment.live_url ? (
                        <a
                          className="deployment-live-url"
                          href={deployment.live_url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {deployment.live_url}
                        </a>
                      ) : null}
                    </div>
                    <div className="deployment-meta">
                      <span className={`status-pill status-${deployment.status}`}>{deployment.status}</span>
                      {deployment.image_tag ? <span className="image-tag">{deployment.image_tag}</span> : null}
                      <span>{formatDate(deployment.created_at)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-state">No deployments yet. Submit one from the form.</p>
            )
          ) : null}
        </section>
      </section>

      {selectedDeployment ? (
        <LogViewer
          deployment={selectedDeployment}
          onClose={() => setSelectedDeployment(null)}
        />
      ) : null}
    </main>
  );
}
