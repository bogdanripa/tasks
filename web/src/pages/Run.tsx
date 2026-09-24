import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { itemPath } from '../api';
import { ErrorNote, Markdown, Time, useFetch } from '../ui';

/** Transcript of a run Tasks executed itself: the assignment, what the model said, and each tool call and result. */
export default function RunPage() {
  const { id } = useParams();
  const { data, error, reload } = useFetch<{ run: any; steps: any[] }>(`/api/runs/${id}`);
  const running = data && !data.run.finishedAt && data.run.status === 'fired';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [running, reload]);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const { run, steps } = data;
  const results = new Map(steps.filter((s) => s.kind === 'tool_result').map((s) => [s.content.id, s.content]));

  return (
    <div className="page narrow run-page">
      <nav className="crumbs">
        <Link to={`/agents/${run.agentId}?tab=activity`}>{run.agentName}</Link>
        <span className="sep">›</span>
      </nav>
      <h1>Run {run.itemRef && <> on <Link to={itemPath(run.itemRef)}>{run.itemRef.split('/')[1]}</Link></>}</h1>
      <p className="muted small">
        {run.itemTitle && <>“{run.itemTitle}” · </>}
        {run.model} · started <Time iso={run.createdAt} /> ·{' '}
        {running ? <span className="working">running</span> : run.error ? <span className="error-text">{run.error}</span> : 'finished'} · {run.steps} steps ·{' '}
        {run.inputTokens.toLocaleString()} in / {run.outputTokens.toLocaleString()} out tokens
      </p>

      <ol className="transcript">
        {steps.map((s) => {
          if (s.kind === 'tool_result') return null; // shown with its call
          if (s.kind === 'system' || s.kind === 'prompt') {
            return (
              <li key={s.id} className="step collapsible">
                <details>
                  <summary>{s.kind === 'system' ? 'Instructions' : 'Assignment from Tasks'}</summary>
                  <pre>{s.content.text}</pre>
                </details>
              </li>
            );
          }
          if (s.kind === 'text') return <li key={s.id} className="step text"><Markdown>{s.content.text}</Markdown></li>;
          if (s.kind === 'tool_call') {
            const res = results.get(s.content.id);
            const out = res?.output;
            return (
              <li key={s.id} className="step tool">
                <div>
                  <code className="tool-name">{s.content.tool}</code> <code className="muted">{JSON.stringify(s.content.input)}</code>
                </div>
                {res?.image && (
                  <img className="screenshot" src={`data:image/jpeg;base64,${res.image}`} alt="What the agent saw" />
                )}
                {out !== undefined && (
                  <details>
                    <summary className="small muted">result</summary>
                    <pre>{typeof out === 'string' ? out : JSON.stringify(out, null, 2)}</pre>
                  </details>
                )}
              </li>
            );
          }
          return <li key={s.id} className={`step ${s.kind}`}>{s.content.text}</li>;
        })}
        {running && <li className="step note"><span className="working">working…</span></li>}
      </ol>
    </div>
  );
}
