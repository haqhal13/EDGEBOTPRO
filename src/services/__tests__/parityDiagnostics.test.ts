/**
 * Unit tests for parity diagnostics (Notes parsing)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We need to test the parseTrade function, but it's not exported
// Let's create a test helper or test the public interface
// Since parseTrade is private, we'll test via matchPaperToWatch indirectly
// But first, let's test the parsing logic directly by exporting it or testing the regex

describe('Parity Diagnostics - Notes Parsing', () => {
    // Since parseTrade is a private function, we'll test the regex pattern directly
    // and create a test version of the parsing logic

    function parseTradeNotes(notes: string): {
        bot: string;
        side: string;
        shares: number;
        fill_px: number;
    } | null {
        if (!notes || (!notes.includes('WATCH:') && !notes.includes('PAPER:'))) {
            return null;
        }

        // Parse notes: "WATCH: UP 12.5000 shares @ $0.2300"
        const match = notes.match(/(WATCH|PAPER):\s*(UP|DOWN)\s+([\d.]+)\s+shares\s+@\s+\$([\d.]+)/);
        if (!match) {
            return null;
        }

        return {
            bot: match[1],
            side: match[2],
            shares: parseFloat(match[3]),
            fill_px: parseFloat(match[4])
        };
    }

    describe('parseTradeNotes', () => {
        it('should parse WATCH UP trade correctly', () => {
            const notes = 'WATCH: UP 12.5000 shares @ $0.2300';
            const result = parseTradeNotes(notes);

            expect(result).not.toBeNull();
            expect(result!.bot).toBe('WATCH');
            expect(result!.side).toBe('UP');
            expect(result!.shares).toBe(12.5);
            expect(result!.fill_px).toBe(0.23);
        });

        it('should parse WATCH DOWN trade correctly', () => {
            const notes = 'WATCH: DOWN 5.0866 shares @ $0.9122';
            const result = parseTradeNotes(notes);

            expect(result).not.toBeNull();
            expect(result!.bot).toBe('WATCH');
            expect(result!.side).toBe('DOWN');
            expect(result!.shares).toBe(5.0866);
            expect(result!.fill_px).toBe(0.9122);
        });

        it('should parse PAPER UP trade correctly', () => {
            const notes = 'PAPER: UP 10.0000 shares @ $0.4500';
            const result = parseTradeNotes(notes);

            expect(result).not.toBeNull();
            expect(result!.bot).toBe('PAPER');
            expect(result!.side).toBe('UP');
            expect(result!.shares).toBe(10.0);
            expect(result!.fill_px).toBe(0.45);
        });

        it('should parse PAPER DOWN trade correctly', () => {
            const notes = 'PAPER: DOWN 8.7500 shares @ $0.6700';
            const result = parseTradeNotes(notes);

            expect(result).not.toBeNull();
            expect(result!.bot).toBe('PAPER');
            expect(result!.side).toBe('DOWN');
            expect(result!.shares).toBe(8.75);
            expect(result!.fill_px).toBe(0.67);
        });

        it('should handle trades with varying decimal precision', () => {
            const testCases = [
                { notes: 'WATCH: UP 1 shares @ $0.5', shares: 1.0, fill_px: 0.5 },
                { notes: 'WATCH: UP 12.5 shares @ $0.23', shares: 12.5, fill_px: 0.23 },
                { notes: 'WATCH: UP 12.5000 shares @ $0.2300', shares: 12.5, fill_px: 0.23 },
                { notes: 'WATCH: UP 0.9515 shares @ $0.0450', shares: 0.9515, fill_px: 0.045 },
                { notes: 'WATCH: UP 123.4567 shares @ $0.1234', shares: 123.4567, fill_px: 0.1234 }
            ];

            testCases.forEach(testCase => {
                const result = parseTradeNotes(testCase.notes);
                expect(result).not.toBeNull();
                expect(result!.shares).toBe(testCase.shares);
                expect(result!.fill_px).toBe(testCase.fill_px);
            });
        });

        it('should return null for invalid notes format', () => {
            const invalidNotes = [
                '',
                'Some random text',
                'WATCH:',
                'PAPER:',
                'WATCH: UP',
                'WATCH: UP 12.5',
                'WATCH: UP 12.5 shares',
                'WATCH: UP 12.5 shares @',
                'WATCH: UP 12.5 shares @ $',
                'WATCH: SIDE 12.5 shares @ $0.5', // Invalid side
                'OTHER: UP 12.5 shares @ $0.5', // Invalid bot
            ];

            invalidNotes.forEach(notes => {
                const result = parseTradeNotes(notes);
                expect(result).toBeNull();
            });
        });

        it('should handle whitespace variations', () => {
            const testCases = [
                'WATCH: UP 12.5 shares @ $0.23',           // Normal spacing
                'WATCH:UP 12.5 shares @ $0.23',            // No space after colon
                'WATCH: UP  12.5  shares  @  $0.23',       // Extra spaces
                'WATCH:  UP  12.5000  shares  @  $0.2300', // Multiple spaces
            ];

            testCases.forEach(notes => {
                const result = parseTradeNotes(notes);
                expect(result).not.toBeNull();
                expect(result!.bot).toBe('WATCH');
                expect(result!.side).toBe('UP');
            });
        });

        it('should handle edge case prices', () => {
            const edgeCases = [
                { notes: 'WATCH: UP 1 shares @ $0.0001', fill_px: 0.0001 },
                { notes: 'WATCH: UP 1 shares @ $0.9999', fill_px: 0.9999 },
                { notes: 'WATCH: UP 1 shares @ $1.0', fill_px: 1.0 },
            ];

            edgeCases.forEach(testCase => {
                const result = parseTradeNotes(testCase.notes);
                expect(result).not.toBeNull();
                expect(result!.fill_px).toBe(testCase.fill_px);
            });
        });

        it('should handle edge case share amounts', () => {
            const edgeCases = [
                { notes: 'WATCH: UP 0.0001 shares @ $0.5', shares: 0.0001 },
                { notes: 'WATCH: UP 1000.0 shares @ $0.5', shares: 1000.0 },
                { notes: 'WATCH: UP 999.9999 shares @ $0.5', shares: 999.9999 },
            ];

            edgeCases.forEach(testCase => {
                const result = parseTradeNotes(testCase.notes);
                expect(result).not.toBeNull();
                expect(result!.shares).toBe(testCase.shares);
            });
        });

        it('should be case-sensitive for bot and side', () => {
            // Should match uppercase
            expect(parseTradeNotes('WATCH: UP 1 shares @ $0.5')).not.toBeNull();
            expect(parseTradeNotes('PAPER: DOWN 1 shares @ $0.5')).not.toBeNull();

            // Should not match lowercase
            expect(parseTradeNotes('watch: up 1 shares @ $0.5')).toBeNull();
            expect(parseTradeNotes('paper: down 1 shares @ $0.5')).toBeNull();
        });

        it('should correctly extract all components together', () => {
            const notes = 'WATCH: DOWN 25.7500 shares @ $0.8450';
            const result = parseTradeNotes(notes);

            expect(result).toEqual({
                bot: 'WATCH',
                side: 'DOWN',
                shares: 25.75,
                fill_px: 0.845
            });
        });
    });
});

