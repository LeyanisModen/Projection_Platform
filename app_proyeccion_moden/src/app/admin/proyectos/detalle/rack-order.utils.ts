export type RackViewOrder = 'transporte' | 'produccion';

export function rackInsertionIndex(visibleIndex: number, remainingCount: number, view: RackViewOrder): number {
    const index = Math.max(0, Math.min(visibleIndex, remainingCount));
    return view === 'produccion' ? remainingCount - index : index;
}
