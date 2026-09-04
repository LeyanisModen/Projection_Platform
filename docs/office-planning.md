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
- Global checklist definitions are shared by all existing/future projects.
  Completion, editor and last-update time are independent per project. Archive
  definitions rather than deleting them, so prior completion marks can be restored.
- Admin Calendar shows project events, mounting dates and office vacations.
  Office workers are independent of login accounts. Events use inclusive date
  ranges (whole days). Availability means no recorded vacation for that day,
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

Historical production charts show actual output only. A changing current deadline
target must not be retroactively presented as a historical target.
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
