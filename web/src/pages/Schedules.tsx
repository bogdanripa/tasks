import { useState } from 'react';
import { api } from '../api';
import { Avatar, ErrorNote, Modal, RefLink, useFetch } from '../ui';

type Freq = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
type When = { freq: Freq; time: string; weekday: number; monthday: number; cron: string };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function toCron(w: When) {
  if (w.freq === 'custom') return w.cron.trim();
  const [h, m] = w.time.split(':').map(Number);
  if (w.freq === 'daily') return `${m} ${h} * * *`;
  if (w.freq === 'weekdays') return `${m} ${h} * * 1-5`;
  if (w.freq === 'weekly') return `${m} ${h} * * ${w.weekday}`;
  return `${m} ${h} ${w.monthday} * *`;
}

/** Recognize the shapes the form produces; anything else is shown as custom cron. */
function fromCron(cron: string): When {
  const base: When = { freq: 'custom', time: '09:00', weekday: 1, monthday: 1, cron };
  const m = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}) \* (\*|1-5|[0-6])$/.exec(cron.trim());
  if (!m) return base;
  const time = `${pad(+m[2])}:${pad(+m[1])}`;
  if (m[3] === '*' && m[4] === '*') return { ...base, freq: 'daily', time };
  if (m[3] === '*' && m[4] === '1-5') return { ...base, freq: 'weekdays', time };
  if (m[3] === '*') return { ...base, freq: 'weekly', time, weekday: +m[4] };
  if (m[4] === '*') return { ...base, freq: 'monthly', time, monthday: +m[3] };
  return base;
}

function describeWhen(cron: string, tz: string) {
  const w = fromCron(cron);
  const zone = tz === browserTz() ? '' : ` (${tz})`;
  switch (w.freq) {
    case 'daily':
      return `Every day at ${w.time}${zone}`;
    case 'weekdays':
      return `Weekdays at ${w.time}${zone}`;
    case 'weekly':
      return `Every ${WEEKDAYS[w.weekday]} at ${w.time}${zone}`;
    case 'monthly':
      return `Monthly on day ${w.monthday} at ${w.time}${zone}`;
    default:
      return `Cron ${cron}${zone}`;
  }
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export function SchedulesSection({ org, projectKey, columns }: { org: string; projectKey: string; columns: string[] }) {
  const base = `/api/projects/${org}/${projectKey}/schedules`;
  const { data, reload } = useFetch<any[]>(base);
  const members = useFetch<any>(`/api/orgs/${org}`).data?.members ?? [];
  const [editing, setEditing] = useState<any | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const save = async (s: any, patch: Record<string, unknown>) =>
    api('PATCH', `/api/schedules/${s.id}`, {
      name: s.name, cron: s.cron, timezone: s.timezone, enabled: s.enabled, title: s.title, body: s.body, status: s.status,
      assignee: s.assigneeId, parent: s.parentRef, skipIfOpen: s.skipIfOpen, ...patch,
    });

  return (
    <div className="stack">
      <p className="muted small">
        Add an item on a timer, e.g. every weekday at 9:00, into a column, assigned to a person or an agent. Items are created as the person who
        last saved the schedule.
      </p>
      {data?.length === 0 && <p className="muted">No recurring tasks yet.</p>}
      <ul className="rows schedules">
        {data?.map((s) => (
          <li key={s.id} className={s.enabled ? '' : 'paused'}>
            <div className="grow">
              <div>
                <b>{s.name}</b> <span className="muted small">· {describeWhen(s.cron, s.timezone)}</span>
              </div>
              <div className="muted small">
                “{s.title}” → {s.status ?? columns[0]}
                {s.parentRef && <> under <RefLink refStr={s.parentRef} /></>}
                {s.assigneeName && <> · <Avatar name={s.assigneeName} kind={s.assigneeKind} size={14} /> {s.assigneeName}</>}
                {s.skipIfOpen && ' · skips while the last one is open'}
              </div>
              <div className="muted small">
                {s.enabled ? <>Next: {when(s.nextRunAt)}</> : 'Paused'}
                {s.lastRunAt && <> · Last: {when(s.lastRunAt)}</>}
                {s.lastItemRef && <> (<RefLink refStr={s.lastItemRef} />)</>}
              </div>
              {s.lastError && <div className="error small">{s.lastError}</div>}
            </div>
            <div className="row-gap">
              <button
                className="ghost small"
                onClick={async () => {
                  try {
                    const r = await api('POST', `/api/schedules/${s.id}/run`);
                    setNotice(r.skipped ? `Skipped: ${r.reason}.` : `Created ${r.ref}.`);
                  } catch (e) {
                    setNotice((e as Error).message);
                  }
                  reload();
                }}
              >
                Run now
              </button>
              <button className="ghost small" onClick={async () => { await save(s, { enabled: !s.enabled }); reload(); }}>
                {s.enabled ? 'Pause' : 'Resume'}
              </button>
              <button className="ghost small" onClick={() => setEditing(s)}>Edit</button>
              <button
                className="ghost small danger"
                onClick={async () => {
                  if (!confirm(`Delete the schedule “${s.name}”? Items it already created stay.`)) return;
                  await api('DELETE', `/api/schedules/${s.id}`);
                  reload();
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {notice && <p className="small">{notice}</p>}
      <div className="actions">
        <button className="small grow-left" onClick={() => setEditing({})}>+ New recurring task</button>
      </div>
      {editing && (
        <ScheduleForm
          initial={editing}
          columns={columns}
          members={members}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            if (editing.id) await api('PATCH', `/api/schedules/${editing.id}`, body);
            else await api('POST', base, body);
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ScheduleForm(props: { initial: any; columns: string[]; members: any[]; onClose: () => void; onSave: (body: any) => Promise<void> }) {
  const i = props.initial;
  const [name, setName] = useState<string>(i.name ?? '');
  const [w, setW] = useState<When>(i.cron ? fromCron(i.cron) : { freq: 'daily', time: '09:00', weekday: 1, monthday: 1, cron: '0 9 * * *' });
  const [timezone, setTimezone] = useState<string>(i.timezone ?? browserTz());
  const [title, setTitle] = useState<string>(i.title ?? '');
  const [body, setBody] = useState<string>(i.body ?? '');
  const [status, setStatus] = useState<string>(i.status ?? props.columns[0]);
  const [assignee, setAssignee] = useState<string>(i.assigneeId ?? '');
  const [parent, setParent] = useState<string>(i.parentRef ?? '');
  const [skipIfOpen, setSkipIfOpen] = useState<boolean>(i.skipIfOpen ?? false);
  const [enabled, setEnabled] = useState<boolean>(i.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const agent = props.members.find((m) => m.id === assignee && m.kind === 'agent');
  const zones = (Intl as any).supportedValuesOf?.('timeZone') ?? [];

  return (
    <Modal title={i.id ? `Edit “${i.name}”` : 'New recurring task'} onClose={props.onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await props.onSave({
              name, cron: toCron(w), timezone, enabled, title, body, status,
              assignee: assignee || null, parent: parent.trim() || null, skipIfOpen,
            });
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label>Name<input autoFocus required value={name} placeholder="Daily Pi check" onChange={(e) => setName(e.target.value)} /></label>

        <label>
          When
          <div className="inline-form" style={{ marginTop: 0, flexWrap: 'wrap' }}>
            <select value={w.freq} onChange={(e) => setW({ ...w, freq: e.target.value as Freq, cron: toCron(w) })} style={{ width: 'auto' }}>
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays (Mon–Fri)</option>
              <option value="weekly">Every week on</option>
              <option value="monthly">Every month on day</option>
              <option value="custom">Custom (cron)</option>
            </select>
            {w.freq === 'weekly' && (
              <select value={w.weekday} onChange={(e) => setW({ ...w, weekday: +e.target.value })} style={{ width: 'auto' }}>
                {WEEKDAYS.map((d, n) => <option key={d} value={n}>{d}</option>)}
              </select>
            )}
            {w.freq === 'monthly' && (
              <input type="number" min={1} max={28} value={w.monthday} onChange={(e) => setW({ ...w, monthday: +e.target.value })} style={{ width: 70 }} />
            )}
            {w.freq === 'custom' ? (
              <input required value={w.cron} placeholder="0 9 * * 1-5" onChange={(e) => setW({ ...w, cron: e.target.value })} style={{ fontFamily: 'monospace' }} />
            ) : (
              <>
                <span className="muted small" style={{ alignSelf: 'center' }}>at</span>
                <input type="time" required value={w.time} onChange={(e) => setW({ ...w, time: e.target.value })} style={{ width: 'auto' }} />
              </>
            )}
          </div>
          {w.freq === 'custom' && <span className="hint">Five fields: minute hour day-of-month month day-of-week.</span>}
        </label>

        <label>
          Timezone
          <input required list="tz-list" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          <datalist id="tz-list">{zones.map((z: string) => <option key={z} value={z} />)}</datalist>
        </label>

        <label>
          Title
          <input required value={title} placeholder="Pi health check {date}" onChange={(e) => setTitle(e.target.value)} />
          <span className="hint">{'{date}'} becomes the run’s date (2026-09-24), {'{weekday}'} its weekday.</span>
        </label>
        <label>
          <span>Description<span className="muted"> (optional, Markdown)</span></span>
          <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>

        <div className="two-col" style={{ gap: 12 }}>
          <label>
            Add to column
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {props.columns.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label>
            Assign to
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Nobody</option>
              {props.members.map((m) => <option key={m.id} value={m.id}>{m.kind === 'agent' ? '🤖 ' : ''}{m.name}</option>)}
            </select>
          </label>
        </div>
        {agent && status.toLowerCase() === 'backlog' && (
          <p className="warn small">Items in Backlog don’t ping agents, so {agent.name} won’t start on these until someone moves them.</p>
        )}

        <label>
          <span>Under issue<span className="muted"> (optional)</span></span>
          <input value={parent} placeholder="e.g. WEB-12, to create a task under it instead of an issue" onChange={(e) => setParent(e.target.value)} />
        </label>

        <label className="check-row">
          <input type="checkbox" checked={skipIfOpen} onChange={(e) => setSkipIfOpen(e.target.checked)} />
          Skip a run while the previous one is still open
        </label>
        <label className="check-row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>

        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={props.onClose}>Cancel</button>
          <button className="primary">{i.id ? 'Save' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}
