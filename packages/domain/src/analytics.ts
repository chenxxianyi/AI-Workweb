import { weekRange } from './date.js';
export interface AnalyticsRow {
  recordDate: string;
  scene: string;
  minutes: number;
  savedMinutes: number;
  effect: number;
}
export function sceneStatistics(rows: readonly AnalyticsRow[]) {
  const groups = new Map<
    string,
    { scene: string; count: number; effectSum: number; savedMinutes: number; minutes: number }
  >();
  for (const row of rows) {
    const group = groups.get(row.scene) ?? {
      scene: row.scene,
      count: 0,
      effectSum: 0,
      savedMinutes: 0,
      minutes: 0,
    };
    group.count++;
    group.effectSum += row.effect;
    group.savedMinutes += row.savedMinutes;
    group.minutes += row.minutes;
    groups.set(row.scene, group);
  }
  return [...groups.values()]
    .map(({ effectSum, ...g }) => ({
      ...g,
      averageEffect: Math.round((effectSum / g.count) * 10) / 10,
    }))
    .sort(
      (a, b) =>
        b.averageEffect - a.averageEffect ||
        b.count - a.count ||
        a.scene.localeCompare(b.scene, 'en'),
    );
}
export function weeklyStatistics(
  rows: readonly Pick<AnalyticsRow, 'recordDate' | 'savedMinutes' | 'minutes'>[],
  endDate: string,
) {
  return weekRange(endDate, 8).map((range) => {
    const week = rows.filter(
      (r) => r.recordDate >= range.start && r.recordDate <= range.end && r.recordDate <= endDate,
    );
    return {
      ...range,
      count: week.length,
      minutes: week.reduce((sum, r) => sum + r.minutes, 0),
      savedMinutes: week.reduce((sum, r) => sum + r.savedMinutes, 0),
    };
  });
}
