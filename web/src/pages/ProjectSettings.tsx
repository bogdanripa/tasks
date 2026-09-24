import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useOrgName, useSession } from '../App';
import { EditableMarkdown, ErrorNote, Tabs, useFetch, useTab } from '../ui';
import pipelineTemplate from '../templates/agent-pipeline.md?raw';
import { FormModal } from './Org';
import { NameField } from './OrgSettings';
import { SchedulesSection } from './Schedules';

const PROJECT_TABS = ['general', 'guidelines', 'board', 'recurring'] as const;

type Column = { name: string; from: string | null; count: number; skill: string };

export default function ProjectSettings() {
  const { org, key } = useParams();
  const { me } = useSession();
  const orgName = useOrgName(org);
  const navigate = useNavigate();
  const { data, error, reload } = useFetch<{ project: any; items: any[] }>(`/api/projects/${org}/${key}`);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useTab(PROJECT_TABS);
  const orgSkills: string[] = useFetch<any>(`/api/orgs/${org}`).data?.skills ?? [];

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const { project, items } = data;
  if (me.orgs.find((o) => o.slug === org)?.role === 'member') {
    return <div className="page"><ErrorNote error="Only admins can change project settings." /></div>;
  }
  const update = async (patch: Record<string, unknown>) => {
    await api('PATCH', `/api/projects/${org}/${key}`, patch);
    await reload();
  };

  return (
    <div className="page narrow settings">
      <nav className="crumbs">
        <Link to={`/${org}`}>{orgName}</Link>
        <span className="sep">›</span>
        <Link to={`/${org}/${key}`}>{project.name}</Link>
        <span className="sep">›</span>
      </nav>
      <h1>Settings</h1>
      <Tabs tabs={PROJECT_TABS} labels={{ general: 'General', guidelines: 'Guidelines', board: 'Board columns', recurring: 'Recurring tasks' }} current={tab} onSelect={setTab} />

      {tab === 'general' && (
      <section>
        <h2>General</h2>
        <div className="stack">
          <NameField label="Project name" value={project.name} onSave={(name) => update({ name })} />
          <NameField label="Short description" allowEmpty value={project.description} onSave={(description) => update({ description })} />
          <p className="muted small">Key: <code>{project.key}</code> (the prefix of item references like {project.key}-12; can’t be changed)</p>
        </div>
      </section>
      )}

      {tab === 'guidelines' && (
      <section>
        <p className="muted small">
          How to work in this project: conventions, definition of done, what needs a human’s approval. Sent to agents with every run on
          this project. They take precedence over the organization’s guidelines.
        </p>
        <EditableMarkdown
          value={project.guidelines}
          placeholder="Add project guidelines…"
          editPlaceholder={'e.g.\n- Deploy from main only.\n- Move work to Review, not Done; a human closes it.\n- Link any follow-up as an issue triggered by the task.'}
          onSave={(guidelines) => update({ guidelines })}
        />
        <div className="actions" style={{ marginTop: 8 }}>
          <button
            className="ghost small grow-left"
            onClick={async () => {
              if (project.guidelines && !confirm('Replace the current guidelines with the agent pipeline template?')) return;
              await update({ guidelines: pipelineTemplate });
            }}
          >
            Use the agent pipeline template
          </button>
        </div>
      </section>
      )}

      {tab === 'board' && (
      <section>
        <ColumnsEditor
          key={project.columns.join('|') + JSON.stringify(project.columnSkills)}
          columns={project.columns}
          columnSkills={project.columnSkills ?? {}}
          skills={orgSkills}
          items={items}
          onSave={(columns) => update({ columns })}
        />
      </section>
      )}

      {tab === 'recurring' && (
      <section>
        <SchedulesSection org={org!} projectKey={key!} columns={project.columns} />
      </section>
      )}

      {tab === 'general' && (
      <section className="danger-zone">
        <div>
          <h2>Delete project</h2>
          <p className="muted small">Permanently removes {project.name} with all its items, comments and history, and their links to other projects.</p>
        </div>
        <button className="danger" onClick={() => setDeleting(true)}>Delete…</button>
      </section>
      )}

      {deleting && (
        <FormModal
          title={`Delete ${project.name}?`}
          fields={[{ name: 'confirm', label: `Type "${project.key}" to confirm`, placeholder: project.key }]}
          submitLabel="Delete permanently"
          danger
          note="This cannot be undone."
          onClose={() => setDeleting(false)}
          onSubmit={async (v) => {
            await api('DELETE', `/api/projects/${org}/${key}`, { confirm: v.confirm });
            navigate(`/${org}`);
          }}
        />
      )}
    </div>
  );
}

function ColumnsEditor(props: {
  columns: string[];
  columnSkills: Record<string, string>;
  skills: string[];
  items: any[];
  onSave: (c: { name: string; from: string | null; skill: string | null }[]) => Promise<unknown>;
}) {
  const { columns, columnSkills, items, onSave } = props;
  const initial = (): Column[] => columns.map((c) => ({ name: c, from: c, count: items.filter((i) => i.status === c).length, skill: columnSkills[c] ?? '' }));
  const [rows, setRows] = useState<Column[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(rows.map((r) => [r.name, r.from, r.skill.trim()])) !== JSON.stringify(columns.map((c) => [c, c, columnSkills[c] ?? '']));
  const set = (i: number, patch: Partial<Column>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: number) => {
    const next = [...rows];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setRows(next);
  };

  return (
    <div className="stack">
      <p className="muted small">
        Left to right. The <b>last column means done</b>; a column named “In progress” (or Doing, WIP, Working) is where agents put work they’ve
        started, and items in “Backlog” don’t ping agents. A <b>default skill</b> sends unassigned items in that column to the least busy member with it
        (e.g. Todo → product). Renaming a column keeps its items in it. A column must be empty before you remove it.
      </p>
      <ol className="columns-editor">
        {rows.map((r, i) => (
          <li key={i}>
            <span className="muted small idx">{i + 1}</span>
            <input value={r.name} maxLength={40} onChange={(e) => set(i, { name: e.target.value })} aria-label={`Column ${i + 1} name`} />
            <input
              className="col-skill"
              list="column-skill-suggestions"
              value={r.skill}
              placeholder="default skill"
              title="Unassigned items in this column go to a member with this skill"
              onChange={(e) => set(i, { skill: e.target.value })}
              aria-label={`Column ${i + 1} default skill`}
            />
            <span className="muted small col-meta">
              {r.from === null ? 'new' : `${r.count} item${r.count === 1 ? '' : 's'}`}
              {r.from && r.from !== r.name.trim() && ` · was ${r.from}`}
              {i === rows.length - 1 && ' · done'}
            </span>
            <button className="icon" title="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="icon" title="Move later" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button
              className="icon"
              title={r.count ? 'Move its items out first' : 'Remove column'}
              disabled={r.count > 0 || rows.length <= 2}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      <datalist id="column-skill-suggestions">{props.skills.map((s) => <option key={s} value={s} />)}</datalist>
      <ErrorNote error={error} />
      <div className="actions">
        <button className="ghost small grow-left" onClick={() => setRows([...rows, { name: '', from: null, count: 0, skill: '' }])} disabled={rows.length >= 12}>
          + Add column
        </button>
        {dirty && <button className="ghost small" onClick={() => { setRows(initial()); setError(null); }}>Reset</button>}
        <button
          className="primary small"
          disabled={!dirty}
          onClick={async () => {
            try {
              await onSave(rows.map((r) => ({ name: r.name.trim(), from: r.from, skill: r.skill.trim() || null })));
              setError(null);
              setSaved(true);
              setTimeout(() => setSaved(false), 1500);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          {saved ? 'Saved' : 'Save columns'}
        </button>
      </div>
    </div>
  );
}
