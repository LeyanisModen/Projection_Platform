import { rackInsertionIndex } from './rack-order.utils';

describe('rackInsertionIndex', () => {
    it('preserves canonical positions in transport view', () => {
        expect([0, 1, 2, 3].map(i => rackInsertionIndex(i, 3, 'transporte'))).toEqual([0, 1, 2, 3]);
    });
    it('reverses insertion positions in production view, including both ends', () => {
        expect([0, 1, 2, 3].map(i => rackInsertionIndex(i, 3, 'produccion'))).toEqual([3, 2, 1, 0]);
    });
    it('works for same-rack moves after removing the dragged module', () => {
        const canonical = ['A', 'B', 'C', 'D'];
        const source = canonical.indexOf('B');
        const target = rackInsertionIndex(0, canonical.length - 1, 'produccion');
        canonical.splice(target, 0, canonical.splice(source, 1)[0]);
        expect([...canonical].reverse()).toEqual(['B', 'D', 'C', 'A']);
    });
    it('clamps positions and handles an empty rack', () => {
        expect(rackInsertionIndex(0, 0, 'produccion')).toBe(0);
        expect(rackInsertionIndex(10, 3, 'produccion')).toBe(0);
        expect(rackInsertionIndex(-1, 3, 'produccion')).toBe(3);
    });
    it('keeps future insertions behind completed work in either view', () => {
        const firstLocked = 1;
        expect(rackInsertionIndex(0, 3, 'produccion') <= firstLocked).toBe(false);
        expect(rackInsertionIndex(2, 3, 'produccion') <= firstLocked).toBe(true);
        expect(rackInsertionIndex(1, 3, 'transporte') <= firstLocked).toBe(true);
        expect(rackInsertionIndex(3, 3, 'transporte') <= firstLocked).toBe(false);
    });
});
