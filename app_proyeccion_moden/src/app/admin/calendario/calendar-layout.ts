export const WORKER_COLORS = ['#2563eb', '#b45309', '#0f766e', '#be185d', '#7c3aed', '#4d7c0f', '#0369a1', '#b91c1c'];

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

export function calendarWeeks(days: CalendarDay[], items: CalendarItem[]): CalendarWeek[] {
    if (!days.length) return [];
    const visible = items.filter(item => item.start <= item.end && item.start <= days.at(-1)!.key && item.end >= days[0].key)
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
        const segments = placed.filter(({item}) => item.start <= week.at(-1)!.key && item.end >= week[0].key)
            .map(({item, lane}) => {
                const start = week.findIndex(day => day.key >= item.start);
                let end = week.length - 1;
                while (week[end].key > item.end) end--;
                return {item, lane, column: start + 1, span: end - start + 1, start: week[start].key, end: week[end].key,
                    continuesBefore: item.start < week[0].key, continuesAfter: item.end > week.at(-1)!.key};
            });
        weeks.push({days: week, segments, lanes: Math.max(0, ...segments.map(segment => segment.lane + 1))});
    }
    return weeks;
}
