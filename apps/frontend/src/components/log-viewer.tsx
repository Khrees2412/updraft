import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Deployment, DeploymentBuild, DeploymentLogEvent } from '@updraft/shared-types';
import { listDeploymentBuilds, redeployDeployment, retryDeployment, streamDeploymentLogs } from '../lib/api';
import { useToast } from './toast';

type StreamState = 'connecting' | 'live' | 'error' | 'done';

interface Props {
  deployment: Deployment;
  onClose: () => void;
  onRedeployQueued: () => Promise<void>;
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function LogViewer({ deployment, onClose, onRedeployQueued }: Props) {
  const toast = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [logs, setLogs] = useState<DeploymentLogEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [liveStatus, setLiveStatus] = useState(deployment.status);
  const [doneStatus, setDoneStatus] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const connect = useCallback((afterSeq: number) => {
    setStreamState('connecting');
    const cleanup = streamDeploymentLogs(deployment.id, afterSeq, {
      onOpen: () => setStreamState('live'),
      onLog: (event) => {
        lastSeqRef.current = event.sequence;
        setLogs((prev) => {
          if (prev.some((l) => l.sequence === event.sequence)) return prev;
          const next = [...prev, event];
          next.sort((a, b) => a.sequence - b.sequence);
          return next;
        });
        // auto-scroll if near bottom
        const el = scrollContainerRef.current;
        if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
          requestAnimationFrame(() => logEndRef.current?.scrollIntoView({ behavior: 'smooth' }));
        }
      },
      onStatus: (status) => setLiveStatus(status as Deployment['status']),
      onDone: (status) => {
        setDoneStatus(status);
        setStreamState('done');
        setLiveStatus(status as Deployment['status']);
      },
      onError: () => {
        setStreamState('error');
        reconnectTimer.current = setTimeout(() => connect(lastSeqRef.current), 3000);
      },
    });
    return cleanup;
  }, [deployment.id]);

  useEffect(() => {
    const cleanup = connect(0);
    return () => {
      cleanup();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  const buildsQuery = useQuery({
    queryKey: ['deployment-builds', deployment.id],
    queryFn: () => listDeploymentBuilds(deployment.id),
  });

  const redeployMutation = useMutation({
    mutationFn: ({ imageTag, action }: { imageTag: string; action: 'redeploy' | 'rollback' }) =>
      redeployDeployment(deployment.id, imageTag, action),
    onSuccess: async (_queued, { action }) => {
      toast.showToast(`${action} queued`, 'success');
      await onRedeployQueued();
    },
  });

  const retryMutation = useMutation({
    mutationFn: () => retryDeployment(deployment.id),
    onSuccess: async () => {
      toast.showToast('Retry queued', 'success');
      await onRedeployQueued();
    },
  });

  const isFailed = liveStatus === 'failed';
  const currentImageTag = deployment.image_tag ?? null;

return (
      <section
        ref={panelRef}
        className={`log-panel${isFailed ? ' log-panel--failed' : ''}${isFullscreen ? ' log-panel--fullscreen' : ''}`}
      >
        <div className="log-panel-header">
          <div className="log-panel-title">
            <span className="log-panel-id">{deployment.id}</span>
            <span className={`stream-indicator stream-${streamState}`}>
              {streamState === 'connecting' && 'Connecting…'}
              {streamState === 'live' && 'Live'}
              {streamState === 'error' && 'Reconnecting…'}
              {streamState === 'done' && `Done · ${doneStatus}`}
            </span>
            {isFailed && (
              <button
                className="retry-button"
                disabled={retryMutation.isPending}
                onClick={() => retryMutation.mutate()}
              >
                {retryMutation.isPending ? 'Retrying...' : 'Retry'}
              </button>
            )}
          </div>
          <div className="log-panel-actions">
            <button
              className="log-fullscreen-button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? '⤓' : '⤒'}
            </button>
            <button className="log-close-button" onClick={onClose} aria-label="Close log viewer">×</button>
          </div>
        </div>
      <div className="build-history">
        <div className="build-history-header">
          <p className="build-history-title">Image tags</p>
          {buildsQuery.isLoading ? <span className="build-history-meta">Loading...</span> : null}
          {buildsQuery.isError ? (
            <span className="build-history-meta error">
              {buildsQuery.error instanceof Error ? buildsQuery.error.message : 'Failed to load builds'}
            </span>
          ) : null}
        </div>
        {buildsQuery.data && buildsQuery.data.length > 0 ? (
          <div className="build-chip-list">
            {buildsQuery.data.map((build: DeploymentBuild) => {
              const isCurrent = build.image_tag === currentImageTag;
              return (
                <div key={build.id} className="build-chip">
                  <span className="build-chip-tag">{build.image_tag}</span>
                  <span className="build-chip-method">{build.build_method}</span>
                  <button
                    className="build-chip-action"
                    disabled={redeployMutation.isPending || isCurrent}
                    onClick={() => redeployMutation.mutate({ imageTag: build.image_tag, action: 'redeploy' })}
                  >
                    Redeploy
                  </button>
                  <button
                    className="build-chip-action ghost"
                    disabled={redeployMutation.isPending || isCurrent}
                    onClick={() => redeployMutation.mutate({ imageTag: build.image_tag, action: 'rollback' })}
                  >
                    Rollback
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="build-history-empty">No image history for this source yet.</p>
        )}
      </div>
      <div className="log-scroll" ref={scrollContainerRef}>
        {logs.length === 0 && streamState === 'connecting' ? (
          <p className="log-empty">Waiting for logs…</p>
        ) : logs.length === 0 ? (
          <p className="log-empty">No logs yet.</p>
        ) : (
          logs.map((log) => (
            <div key={log.sequence} className={`log-line log-stage-${log.stage}`}>
              <span className="log-ts">{formatTs(log.timestamp)}</span>
              <span className="log-stage-label">{log.stage}</span>
              <span className="log-msg">{log.message}</span>
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>
    </section>
  );
}
