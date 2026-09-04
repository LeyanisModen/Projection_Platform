import { CalendarDay, CalendarItem, calendarMonths, calendarRange, calendarWeeks, localDate, monthDays, nextWorkerColor, workerColor } from './calendar-layout';

const days: CalendarDay[] = Array.from({length: 42}, (_, i) => {
    const date = new Date(2026, 7, 31 + i);
    return {key: `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`,
        number: date.getDate(), current: date.getMonth() === 8};
});

describe('calendar periods', () => {
    it('uses the reference month plus two, rather than fixed calendar quarters', () => {
        expect(calendarMonths(new Date(2026, 8, 1), 'quarter').map(localDate)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
        expect(calendarMonths(new Date(2026, 10, 1), 'quarter').map(localDate)).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
        expect(calendarRange(new Date(2026, 10, 1), 'quarter')).toEqual({start: '2026-11-01', end: '2027-01-31'});
    });
    it('shows all twelve months of the reference year', () => {
        const months = calendarMonths(new Date(2026, 8, 1), 'year');
        expect(months).toHaveLength(12);
        expect(localDate(months[0])).toBe('2026-01-01');
        expect(localDate(months[11])).toBe('2026-12-01');
        expect(calendarRange(new Date(2026, 8, 1), 'year')).toEqual({start: '2026-01-01', end: '2026-12-31'});
    });
    it('handles leap February and daylight-saving changes using local dates', () => {
        expect(monthDays(new Date(2028, 1, 1), true).filter(d => d.current)).toHaveLength(29);
        expect(monthDays(new Date(2026, 2, 1), true).filter(d => d.current).map(d => d.key)).toContain('2026-03-29');
        expect(monthDays(new Date(2026, 9, 1), true).filter(d => d.current).map(d => d.key)).toContain('2026-10-25');
        const yearDays = calendarMonths(new Date(2028, 1, 1), 'year').flatMap(m => monthDays(m, true).filter(d => d.current));
        expect(new Set(yearDays.map(d => d.key)).size).toBe(366);
    });
    it('preserves the 42-day monthly window but compacts multi-month grids', () => {
        expect(monthDays(new Date(2027, 1, 1), true)).toHaveLength(28);
        expect(monthDays(new Date(2027, 1, 1))).toHaveLength(42);
        expect(calendarRange(new Date(2026, 8, 1), 'month')).toEqual({start: '2026-08-31', end: '2026-10-11'});
    });
    it('clips multi-month bars to each actual month without losing continuation or duplicating dates', () => {
        const item = event('a', '2026-09-29', '2026-10-03');
        const september = calendarWeeks(monthDays(new Date(2026, 8, 1), true), [item], true).flatMap(w => w.segments);
        const october = calendarWeeks(monthDays(new Date(2026, 9, 1), true), [item], true).flatMap(w => w.segments);
        expect(september).toHaveLength(1);
        expect(october).toHaveLength(1);
        expect(september[0]).toMatchObject({column: 2, span: 2, start: '2026-09-29', end: '2026-09-30', continuesAfter: true});
        expect(october[0]).toMatchObject({column: 4, span: 3, start: '2026-10-01', end: '2026-10-03', continuesBefore: true});
        expect(october[0].item.start).toBe('2026-09-29');
    });
    it('does not render neighboring-month events in empty padding cells', () => {
        const segments = calendarWeeks(monthDays(new Date(2026, 8, 1), true), [event('a','2026-08-31','2026-08-31')], true).flatMap(w => w.segments);
        expect(segments).toEqual([]);
    });
});
const event = (key: string, start: string, end: string): CalendarItem => ({
    key, title: key, start, end, colors: ['#2563eb'], people: 'Ana', mounting: false,
});

describe('calendar continuous bars', () => {
    it('renders one inclusive bar for a range within a week', () => {
        const segments = calendarWeeks(days, [event('a', '2026-09-08', '2026-09-10')]).flatMap(w => w.segments);
        expect(segments).toHaveLength(1);
        expect(segments[0]).toMatchObject({column: 2, span: 3, lane: 0, continuesBefore: false, continuesAfter: false});
    });
    it('splits only at week boundaries and retains the same lane', () => {
        const weeks = calendarWeeks(days, [event('a', '2026-09-07', '2026-09-16'), event('b', '2026-09-16', '2026-09-27')]);
        const first = weeks.flatMap(w => w.segments).filter(s => s.item.key === 'a');
        const second = weeks.flatMap(w => w.segments).filter(s => s.item.key === 'b');
        expect(first.map(s => s.span)).toEqual([7, 3]);
        expect(second.map(s => s.span)).toEqual([5, 7]);
        expect(first.every(s => s.lane === 0)).toBe(true);
        expect(second.every(s => s.lane === 1)).toBe(true);
        expect(first[0].continuesAfter).toBe(true);
        expect(first[1].continuesBefore).toBe(true);
    });
    it('clips events crossing the month and visible range without dropping their dates', () => {
        const segments = calendarWeeks(days, [event('a', '2026-08-10', '2026-10-20')]).flatMap(w => w.segments);
        expect(segments).toHaveLength(6);
        expect(segments.every(s => s.span === 7 && s.continuesBefore && s.continuesAfter)).toBe(true);
        expect(segments[0].item.start).toBe('2026-08-10');
    });
    it('does not overlap inclusive end dates, reuses lanes later, and is deterministic', () => {
        const items = [event('b', '2026-09-08', '2026-09-09'), event('a', '2026-09-07', '2026-09-08'), event('c', '2026-09-09', '2026-09-09')];
        const weeks = calendarWeeks(days, items);
        expect(weeks).toEqual(calendarWeeks(days, [...items].reverse()));
        expect(weeks[1].segments.map(s => [s.item.key, s.lane, s.span])).toEqual([['a', 0, 2], ['b', 1, 2], ['c', 0, 1]]);
    });
    it('keeps all overlapping events, including single-day mounts', () => {
        const items = Array.from({length: 6}, (_, i) => event(String(i), '2026-09-10', '2026-09-10'));
        items[0].mounting = true;
        const week = calendarWeeks(days, items)[1];
        expect(week.lanes).toBe(6);
        expect(week.segments).toHaveLength(6);
        expect(week.segments.every(s => s.span === 1 && s.column === 4)).toBe(true);
    });
    it('ignores out-of-range or invalid events and accepts an empty calendar', () => {
        expect(calendarWeeks([], [])).toEqual([]);
        expect(calendarWeeks(days, [event('old','2025-01-01','2025-01-02'), event('bad','2026-09-10','2026-09-09')]).every(w => w.lanes === 0)).toBe(true);
    });
    it('chooses distinct defaults and safely handles an older API without colors', () => {
        expect(nextWorkerColor(['#2563EB'])).toBe('#b45309');
        expect(workerColor(undefined, 2)).toBe('#b45309');
        expect(workerColor('invalid', 1)).toBe('#2563eb');
        expect(workerColor('#123456', 1)).toBe('#123456');
    });
});
