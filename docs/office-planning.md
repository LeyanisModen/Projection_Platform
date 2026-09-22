# Project controls and office planning

## Scope

- Ferrallas can restart their own INF/SUP phases from the project module modal.
  A confirmation is required. Manual completion and full-module mutations remain
  admin-only; normal player completion is unchanged. Existing photos and the
  opposite phase are preserved. Restart keeps the existing queue-priority logic.
- Admin project detail replaces the simulated table preview with a production /
  transport rack-view selector. Production reverses modules inside each rack;
  the configured rack sequence is unchanged. Drag/drop translates visual positions
  to canonical transport indices and retains locks around work already started.
- Photo modals use the full viewport on narrow screens, with touch-sized controls
  below the image. Existing pinch/drag zoom remains available.
- Project checklist (September 2026 redesign; no data existed before it):
  the admin page "Lista de control" holds a master list of steps. Creating a
  project copies the master steps into `ProyectoCheck` rows owned by that
  project; from then on the project's list is independent (add project-only
  steps, delete any step, "Traer los pasos de la lista maestra que falten"
  re-copies missing ones by title). Editing or deleting master steps never
  touches seeded projects. Completing a step records who and when; unmarking
  clears both. The project detail shows a progress bar and opens the list in
  a modal. Staff only.
- Each step declares what it needs, on the master list and on the project
  copy (`requiere_fecha`, `requiere_documento`): a due date (`fecha_limite`,
  shown in the admin calendar as a read-only "Control" item and in the day
  agenda, green with a check mark once completed) and/or confirmation
  documents (`ProyectoCheckAdjunto`, stored under
  `media/controles/<proyecto>/<check>/`, 20 MB each, staff-only through
  `/media/`; a paired mini-PC can only read `imagenes/` and `fotos/`).
  Clearing `requiere_fecha` clears the due date. Completing a step that
  requires a document without one is allowed but flagged in the list.
- Validation gates (2026-09-22, from the office's "D-day" process; D is the
  mounting date `fecha_montaje`):
  - `dias_antes_montaje` on a master step (implies `requiere_fecha`) makes the
    project copy compute `fecha_limite = D - days` when seeding, and
    `recalcular_fechas_checklist` recomputes it whenever D changes, only for
    steps that are still pending and carry a relative deadline (completed
    steps and hand-set dates are left alone; no D means no date). Shown as
    `D−30` in the master list and the project modal.
  - `requisitos` (M2M on the definition, copied by title to the project) are
    prerequisites: PATCH `completado=true` is refused with the pending titles
    until they are done, and the modal disables the checkbox with the same
    hint. `requisitos_pendientes` comes in every project row.
  - `bloquea_produccion` marks validations the client must have before
    fabricating (geometry, equivalences, technical justifications). While
    any is pending, `Proyecto.produccion_bloqueada` is true: the client
    dashboard leaves the project out of the "Gestionar" add-to-queue list
    (with a "Pendiente de validación con Moden" note) and `cola/add` answers
    400 naming the missing steps, so a direct call cannot bypass it. The
    admin project card shows "Sin producción hasta completar: ...".
- Admin Calendar shows project events, mounting dates and office vacations.
  Office workers are independent of login accounts. Events use inclusive date
  ranges (whole days). Availability means no recorded vacation or assigned event for that day,
  not a guarantee of attendance. Inactive workers keep historical events.

## Deadline rules

`Proyecto.fecha_montaje` is nullable for existing projects. Working days belong
only to the assigned ferralla: `UserProfile.capture_active_days`, already edited
in "Horario y camaras". Projects do not store a separate schedule. The read-only
`planificacion.dias_produccion` response contains the effective factory days for
display/forecasting. Saving a mounting date never changes the factory schedule.
Changing that schedule recalculates every assigned project's demand on its next
read; reassigning a project immediately uses the new ferralla's working days.
Missing profiles use the existing factory default (Monday-Friday) without creating
a profile during reads; an explicitly empty schedule is not replaced by defaults.
Projects with no assigned ferralla are flagged rather than assuming working days.

`daily demand = ceil(unfinished modules / remaining selected production days)`.
Count the ferralla's working days from the calculation date up to, but NOT
including, the mounting date.
Completed/closed modules do not count as unfinished. Recalculate on every API
read; no cron task or stored derived counter is needed. The ferralla total sums
all its project demands, including projects not currently assigned to tables.
There is no nominal 12/day fallback. Missing dates, exhausted deadlines or no
remaining working days show warnings instead of an invented feasible rate.
Public holidays and office vacations do not automatically stop factory production.

The client dashboard's Modules KPI shows `completed / period target` (e.g. `3 / 9`),
not current daily demand as a separate subtitle or a banner above production.
Both numbers cover the selected inclusive date range: today, week to date or month
to date. Summary cards remain visible with zero output, including before any table
starts work. Only empty detail tables/charts are hidden. Historical production
charts continue to show actual output only, without a daily-target line.

`esperado.modulos_esperados` reconstructs a target for that range from the current
project plans. For each assigned project, take its modules minus completions before
the range's first local midnight, and calculate the daily demand over its factory
working days from that start up to (excluding) mounting. Multiply by the working
days within the selected range before mounting, and cap at those outstanding
modules. Sum every assigned project's result, including projects not in table
queues. The optional project API filter also scopes this calculation; the selected
project in the dashboard does not narrow factory-wide statistics.

Completions within the period increase the numerator without reducing its target:
`3 / 9` must not become `3 / 6`. A finished project retains its target when viewing
the period in which it finished. Dates use the same local timezone as statistics.
Legacy completed modules without a completion date are treated as already done.
No working days in the selected range means zero target, provided the project has
working days available before mounting. Missing or exhausted deadlines at the
range's start, empty projects and missing factory schedules are reported through
`esperado.proyectos_sin_objetivo`; an entirely uncalculable target shows `?`, not zero.
When only some projects are calculable, their sum is shown with a partial-target
warning. These range-specific warnings take precedence over current daily-demand
warnings, since a historical range may still have a valid target.

This is a recalculation with current deadlines, assignments, modules and schedules,
NOT a stored historical planning snapshot. Editing any of those or restarting a
module can change reconstructed targets. There is no project/module creation date
to infer a historical production start, so calculation starts at the range boundary.
No migration, production-data rewrite or new scheduled task is needed.
Request failures are shown separately from a successful response with no output.
Legacy capacity fields remain in the schema/API for compatibility, but new UI
planning no longer uses them.

## Storage and migration

Migration `0054_office_planning_and_phase_dates` adds the project mounting date,
phase timestamps, global checklist definitions/project states, office workers
and events. Existing projects keep an empty mounting date. Phase dates are
backfilled only where a completed phase has a historical HECHO queue timestamp;
otherwise the UI reports an unknown historical date. No photo deletion is involved.
New phase completion stamps its date; restart clears only that phase's date.

Backend logic: `api/planning.py`, `api/office.py`, `Modulo.save`,
`ProyectoSerializer`, `ModuloViewSet` and `ProductionStatsView`.
Frontend: `project-controls.component.ts`, `calendario.component.*`,
`rack-order.utils.ts`, `project-planning.ts`, dashboard and responsive stylesheets.
Office endpoints are admin-only: `check-definiciones`, `proyecto-checklist`,
`trabajadores`, `eventos`. Restart remains scoped through the module queryset.

## Calendar colors and ranges

Migration `0055_office_worker_color` gives existing office workers distinct colors
from an eight-color palette (reused for larger teams), without changing their events.
Admins can change each person's color in "Gestionar equipo", including custom
six-digit hex colors. Colors are stored on the worker, not copied into each event,
so edits also recolor previous events. Shared events show a stripe for each person;
unassigned events use gray and mounting dates retain their orange styling.

Vacation ranges shade the whole background of each inclusive day instead of
occupying event lanes. Overlapping people appear as separate translucent horizontal
bands, with each person included once per day even if their vacation records
overlap. Dates and event buttons remain above the tint and clickable. The day's
accessible label and tooltip name the absent people; selecting it keeps the
vacation dates, notes, editing and deletion available in the agenda. Changing a
worker's color updates both shading and event bars without editing event records.

Events and mounting dates remain one bar per week, not one chip per day. Bars
continue across week/month boundaries, retain their lane within the visible month,
and never overlap another event on the same day/lane. Titles wrap up to three lines
in the month and two in compact views; rows grow to fit instead of clipping the
next event. The full title remains available in the tooltip and selected day's
agenda. Printing removes the line limit. Calendar project/person filters retain
their existing scope, while actual office availability remains unfiltered.

The view selector offers a month, a rolling three-month window, and January to
December of the reference year. The quarter starts at the reference month (initially
the current month); its arrows move one month, not one fixed calendar quarter.
Annual arrows move one year. "Hoy" returns to the current date without changing
the selected view. Month headings open that month in detail and retain filters.
Multi-month views hide padding dates and clip bars to the actual month, keeping
continuation indicators and full original dates. One events request covers the
whole selected period; older in-flight loads are cancelled. No new migration is
needed for the additional views.

## Event editor and printing

The editor has separate Event and Vacation tabs. Events require a title and date
range, with optional project, people and description. Assigning people to an event
marks them as out of office on every inclusive day of its range. Vacations require
at least one person, dates and optional notes, but no manual title or project.
The API generates `Vacaciones de <names>` and returns the current names on reads;
existing multi-person vacations remain editable. Their stored legacy titles are
not rewritten until saved. Vacation saves clear project association. No schema
migration or deletion of existing events is needed.

Availability uses all loaded events, regardless of project/person filters. A
vacation takes precedence over the out-of-office label when both overlap.
This is still a whole-day calendar, not an hourly attendance register. Office
events and vacations do not alter the working days of a factory or its targets.

An inline person editor adds a name and color without closing the event dialog.
It selects the new person automatically, retaining existing selections and draft
fields. Saving a person persists that person independently of saving/cancelling
the event; the dialog explains this. The event cannot be submitted while that
inline editor is open or a save request is pending.

The person picker shows advisory overlaps (vacations and other events, inclusive
dates) for the entire draft range. Its separate GET request ignores calendar
filters, also covers months outside the current view, excludes the event being
edited, and is cancelled on date changes or closing the dialog. It never blocks
person selection or saving, including while the overlap check is loading or has
failed. Failed checks are shown as unknown with a retry action, not as available.
These warnings apply to both event and vacation tabs and use full days, not hours.

The `Anual` view displays all twelve months with shaded daily cells for
vacations (overlapping people stack their colors), a team legend that keeps
inactive people with visible historical vacations, plus event bars, mounting
dates and checklist due dates. The former separate `Vacaciones anual` view was
removed in September 2026 as redundant. Vacation shading is drawn inset inside
each day cell (margin and rounded corners) so the day grid stays visible when a
whole week is shaded.

`Imprimir / PDF` opens the browser's print dialog for the current loaded view and
filters. Print styles release the admin scroll containers, remove navigation,
forms and the day sidebar, and include the period, filters and color legend.
The annual view uses a compact three-column A4 portrait layout (four rows of
months). The rolling quarter stacks compact months without forced page breaks.
A typical four-person calendar fits on one sheet; busy months grow naturally
and move to another page rather than clipping event labels or hiding dates.
The monthly view keeps its larger detail layout. Loading/error states disable the print
button. Browser checks use mocked data and generated PDFs; a physical printer
and its color settings still need user acceptance.

Print regression checks: explicitly emulate `print` media before generating a
Playwright PDF (a previous `screen` media override otherwise masks print styles).
Verify twelve month headings and every day in annual output, all non-vacation
event labels, vacation shading, the team legend, and no admin navigation. With
four people, two overlapping September vacations and a shared event,
monthly/quarterly/annual/vacation PDFs each use one A4 page. A stress case with
four additional overlapping short events in every month uses two pages for the
year and preserves all twelve months and all 48 additional event labels. Long
single-day titles can also cause extra pages, rather than truncating their text;
the vacation-only annual summary remains one page for these fixtures.

## Verification and rollout

Run from `api_proyeccion_moden`:

```powershell
.\venv\Scripts\python.exe manage.py check
.\venv\Scripts\python.exe manage.py makemigrations --check --dry-run
.\venv\Scripts\python.exe manage.py test api --noinput
```

Run from `app_proyeccion_moden`:

```powershell
npm test -- --watch=false
npm run build
```

Before publishing, back up the target database. Deploy backend and apply
`manage.py migrate --noinput` (existing deployment startup handles migrations),
then deploy frontend. Verify in Railway staging before promoting to production.
Do not reverse migration 0054 after entering real checklist/event data: reversing
it removes the new tables. Revert application code alone if necessary.

Acceptance: two ferrallas cannot restart each other's modules; SUP restart leaves
INF and photos intact; checklist marks do not leak between projects; a new global
check appears everywhere; vacations spanning months show on every covered day;
mounting dates appear automatically; multiple projects sum their daily demand;
rack view toggles and drag/drop preserve the real sequence. Check mobile photo
modals in portrait and landscape with actual phone touch interaction.

Browser layout checks during implementation used mocked API data at 320x568,
390x844 and 844x390; they do not replace a real-device/staging acceptance test.
