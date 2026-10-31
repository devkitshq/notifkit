function localTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  for (let iter = 0; iter < 3; iter++) {
    const parts = formatter.formatToParts(new Date(utcMs));
    const pYear = parseInt(parts.find((p) => p.type === "year")?.value ?? "0", 10);
    const pMonth = parseInt(parts.find((p) => p.type === "month")?.value ?? "0", 10);
    const pDay = parseInt(parts.find((p) => p.type === "day")?.value ?? "0", 10);
    const pHour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const pMin = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    const pSec = parseInt(parts.find((p) => p.type === "second")?.value ?? "0", 10);

    const targetMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const actualMs = Date.UTC(pYear, pMonth - 1, pDay, pHour, pMin, pSec);
    const diff = targetMs - actualMs;
    if (diff === 0) break;
    utcMs += diff;
  }
  return new Date(utcMs);
}

export function isInQuietHours(
  timezone: string,
  quietHours: { start: string; end: string }[],
  fromDate: Date = new Date(),
): { inQuietHours: boolean; nextActiveTime?: Date } {
  if (!quietHours || quietHours.length === 0) {
    return { inQuietHours: false };
  }

  const checkWindowAt = (date: Date) => {
    let parts: Intl.DateTimeFormatPart[];
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      parts = formatter.formatToParts(date);
    } catch {
      return null;
    }

    const year = parseInt(parts.find((p) => p.type === "year")?.value ?? "0", 10);
    const month = parseInt(parts.find((p) => p.type === "month")?.value ?? "0", 10);
    const day = parseInt(parts.find((p) => p.type === "day")?.value ?? "0", 10);
    const currentHour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const currentMin = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);

    const currentMinutes = currentHour * 60 + currentMin;

    for (const window of quietHours) {
      const [startH, startM] = window.start.split(":").map(Number);
      const [endH, endM] = window.end.split(":").map(Number);

      if (startH === undefined || startM === undefined || endH === undefined || endM === undefined)
        continue;

      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      let inWindow = false;
      if (startMinutes <= endMinutes) {
        inWindow = currentMinutes >= startMinutes && currentMinutes < endMinutes;
      } else {
        inWindow = currentMinutes >= startMinutes || currentMinutes < endMinutes;
      }

      if (inWindow) {
        let targetYear = year;
        let targetMonth = month;
        let targetDay = day;

        if (currentMinutes >= endMinutes) {
          const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
          targetYear = nextDay.getUTCFullYear();
          targetMonth = nextDay.getUTCMonth() + 1;
          targetDay = nextDay.getUTCDate();
        }

        let nextActive = localTimeToUtc(
          targetYear,
          targetMonth,
          targetDay,
          endH,
          endM,
          0,
          timezone,
        );
        // In a DST fall-back hour the end time occurs twice and localTimeToUtc
        // picks the first, which can already be behind us; use the current
        // UTC offset to land on the second occurrence instead.
        if (nextActive.getTime() <= date.getTime()) {
          const currentSec = parseInt(parts.find((p) => p.type === "second")?.value ?? "0", 10);
          const offsetMs =
            Date.UTC(year, month - 1, day, currentHour, currentMin, currentSec) -
            Math.floor(date.getTime() / 1000) * 1000;
          nextActive = new Date(
            Date.UTC(targetYear, targetMonth - 1, targetDay, endH, endM, 0) - offsetMs,
          );
        }
        return { inQuietHours: true, nextActiveTime: nextActive };
      }
    }
    return { inQuietHours: false };
  };

  let initialCheck = checkWindowAt(fromDate);
  if (!initialCheck || !initialCheck.inQuietHours) {
    return { inQuietHours: false };
  }

  // Chained / overlapping quiet hours intervals
  let candidateTime = initialCheck.nextActiveTime!;
  for (let i = 0; i < 10; i++) {
    const subsequentCheck = checkWindowAt(candidateTime);
    if (subsequentCheck && subsequentCheck.inQuietHours && subsequentCheck.nextActiveTime) {
      if (subsequentCheck.nextActiveTime.getTime() <= candidateTime.getTime()) {
        break;
      }
      candidateTime = subsequentCheck.nextActiveTime;
    } else {
      break;
    }
  }

  return { inQuietHours: true, nextActiveTime: candidateTime };
}
