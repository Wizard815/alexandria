import { useWorld, useLoad } from '../../lib/world.tsx';

export interface Month { name: string; days: number; intercalary?: boolean }
export interface Calendar {
  name: string; epochYear: number; yearSuffix?: string; months: Month[]; weekdays: string[];
  moons?: { name: string; cycleDays: number; offsetDays: number }[];
  seasons?: { name: string; month: number; day: number }[];
}
export interface DateParts {
  year: number; month: number; day: number; hour: number; minute: number; weekday: string | null; monthName: string;
  season: string | null; timeOfDay: string; moons: { name: string; phase: string }[];
}
export interface ClockState {
  minutes: number; date: DateParts; label: string; calendar: Calendar; calendarSource: string;
  longRestMode?: '8h' | 'morning';
  builtins?: { key: string; name: string }[];
  sources?: { sourceId: string; externalId: string; name: string; usable: boolean; current: { year: number; month: number; day: number } | null }[];
}
export interface WEvent {
  id: string; title: string; description: string; start: number; end: number | null; visibility: 'dm' | 'party';
  repeat: 'yearly' | null; kind: string; startLabel: string; startDate: DateParts; endDate: DateParts | null;
  occursAt?: number; occursLabel?: string; daysAway?: number;
}
export interface LogEntry {
  id: string; at: string; accountName: string | null; kind: string; reason: string;
  beforeLabel: string; afterLabel: string; undone: boolean; undoable: boolean;
}

export const KINDS = ['holiday', 'deadline', 'travel', 'rest', 'session', 'custom'];

export function useClock() {
  const { w } = useWorld();
  return useLoad<ClockState>(() => w.call('GET', '/clock'), [w], ['clock', 'world-event']);
}

export const dayWord = (n: number | undefined) => (n === undefined ? '' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n < 0 ? `${-n} days ago` : `in ${n} days`);
