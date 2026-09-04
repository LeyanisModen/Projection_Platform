export const WORKER_COLORS = ['#2563eb', '#b45309', '#0f766e', '#be185d', '#7c3aed', '#4d7c0f', '#0369a1', '#b91c1c'];
export type CalendarView = 'month' | 'quarter' | 'year';

export function localDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

export function calendarMonths(anchor: Date, view: CalendarView): Date[] {
    const start = view === 'year' ? 0 : anchor.getMonth();
    const count = view === 'year' ? 12 : view === 'quarter' ? 3 : 1;
    return Array.from({length: count}, (_, i) => new Date(anchor.getFullYear(), start + i, 1));
}

export function monthDays(month: Date, compact = false): CalendarDay[] {
    const offset = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
    const length = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const count = compact ? Math.ceil((offset + length) / 7) * 7 : 42;
    return Array.from({length: count}, (_, i) => {
        const date = new Date(month.getFullYear(), month.getMonth(), 1 - offset + i);
        return {key: localDate(date), number: date.getDate(), current: date.getMonth() === month.getMonth()};
    });
}

export function calendarRange(anchor: Date, view: CalendarView): {start: string; end: string} {
    if (view === 'month') {
        const days = monthDays(anchor);
        return {start: days[0].key, end: days.at(-1)!.key};
    }
    const months = calendarMonths(anchor, view);
    const last = months.at(-1)!;
    return {start: localDate(months[0]), end: localDate(new Date(last.getFullYear(), last.getMonth() + 1, 0))};
}

export interface CalendarDay { key: string; number: number; current: boolean; }
export interface CalendarItem {
    key: string;
    title: string;
    start: string;
    end: string;
    colors: string[];
    people: string;
    mounting: boolean;
}
export interface CalendarSegment {
    item: CalendarItem;
    column: number;
    span: number;
    lane: number;
    start: string;
    end: string;
    continuesBefore: boolean;
    continuesAfter: boolean;
}
export interface CalendarWeek { days: CalendarDay[]; segments: CalendarSegment[]; lanes: number; }

export function workerColor(color: string | undefined, id: number): string {
    return color && /^#[0-9a-f]{6}$/i.test(color) ? color : WORKER_COLORS[(id - 1) % WORKER_COLORS.length];
}

export function nextWorkerColor(colors: string[]): string {
    return [...WORKER_COLORS].sort((a, b) =>
        colors.filter(c => c.toLowerCase() === a).length - colors.filter(c => c.toLowerCase() === b).length,
    )[0];
}

export function calendarWeeks(days: CalendarDay[], items: CalendarItem[], currentMonthOnly = false): CalendarWeek[] {
    const activeDays = currentMonthOnly ? days.filter(day => day.current) : days;
    if (!activeDays.length) return [];
    const rangeStart = activeDays[0].key;
    const rangeEnd = activeDays.at(-1)!.key;
    const visible = items.filter(item => item.start <= item.end && item.start <= rangeEnd && item.end >= rangeStart)
        .sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end) || a.key.localeCompare(b.key));
    const laneEnds: string[] = [];
    // Allocate lanes over the whole visible range so a bar keeps its row across weeks.
    const placed = visible.map(item => {
        let lane = laneEnds.findIndex(end => end < item.start);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = item.end;
        return {item, lane};
    });
    const weeks: CalendarWeek[] = [];
    for (let offset = 0; offset < days.length; offset += 7) {
        const week = days.slice(offset, offset + 7);
        const startBound = week[0].key > rangeStart ? week[0].key : rangeStart;
        const endBound = week.at(-1)!.key < rangeEnd ? week.at(-1)!.key : rangeEnd;
        const segments = placed.filter(({item}) => startBound <= endBound && item.start <= endBound && item.end >= startBound)
            .map(({item, lane}) => {
                const start = week.findIndex(day => day.key >= item.start && day.key >= startBound);
                let end = week.length - 1;
                while (week[end].key > item.end || week[end].key > endBound) end--;
                return {item, lane, column: start + 1, span: end - start + 1, start: week[start].key, end: week[end].key,
                    continuesBefore: item.start < week[start].key, continuesAfter: item.end > week[end].key};
            });
        weeks.push({days: week, segments, lanes: Math.max(0, ...segments.map(segment => segment.lane + 1))});
    }
    return weeks;
}
