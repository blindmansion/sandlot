/**
 * Mock agent that generates code using date-fns.
 *
 * Demonstrates that the dynamic export introspection works with
 * any library, not just React with its hardcoded exports.
 */

import type { Sandbox } from "sandlot";

/**
 * Runs a mock agent that writes a date utility script using date-fns.
 */
export async function runDateAgent(sandbox: Sandbox, prompt: string): Promise<void> {
  // Write the script
  const code = generateDateCode(prompt);
  await sandbox.fs.writeFile("/src/index.ts", code);

  // Build (skip typecheck - date-fns types are complex and esm.sh doesn't fully expose them)
  // The dynamic export feature still works correctly at runtime
  const buildResult = await sandbox.bash.exec("build /src/index.ts --skip-typecheck");
  if (buildResult.exitCode !== 0) {
    throw new Error(`Build failed:\n${buildResult.stderr || buildResult.stdout}`);
  }
}

/**
 * Generate date utility code based on the prompt.
 */
function generateDateCode(prompt: string): string {
  const lowerPrompt = prompt.toLowerCase();

  if (lowerPrompt.includes("birthday") || lowerPrompt.includes("age")) {
    return `import { differenceInYears, differenceInDays, format, addYears } from "date-fns";

export interface AgeResult {
  years: number;
  daysUntilNextBirthday: number;
  nextBirthdayFormatted: string;
}

export function calculateAge(birthDate: Date): AgeResult {
  const today = new Date();
  const years = differenceInYears(today, birthDate);
  
  // Calculate next birthday
  let nextBirthday = addYears(birthDate, years + 1);
  if (nextBirthday < today) {
    nextBirthday = addYears(birthDate, years + 2);
  }
  
  const daysUntilNextBirthday = differenceInDays(nextBirthday, today);
  const nextBirthdayFormatted = format(nextBirthday, "MMMM do, yyyy");
  
  return { years, daysUntilNextBirthday, nextBirthdayFormatted };
}

// Example usage
const result = calculateAge(new Date(1990, 0, 15));
export const exampleOutput = \`You are \${result.years} years old. Next birthday: \${result.nextBirthdayFormatted} (\${result.daysUntilNextBirthday} days away)\`;
`;
  }

  if (lowerPrompt.includes("countdown") || lowerPrompt.includes("event")) {
    return `import { differenceInDays, differenceInHours, differenceInMinutes, format, isPast } from "date-fns";

export interface CountdownResult {
  days: number;
  hours: number;
  minutes: number;
  isPast: boolean;
  formatted: string;
}

export function getCountdown(eventDate: Date, eventName: string): CountdownResult {
  const now = new Date();
  const past = isPast(eventDate);
  
  const days = Math.abs(differenceInDays(eventDate, now));
  const hours = Math.abs(differenceInHours(eventDate, now)) % 24;
  const minutes = Math.abs(differenceInMinutes(eventDate, now)) % 60;
  
  const formatted = past
    ? \`\${eventName} was \${days} days ago\`
    : \`\${days}d \${hours}h \${minutes}m until \${eventName}\`;
  
  return { days, hours, minutes, isPast: past, formatted };
}

// Example: New Year countdown
const newYear = new Date(new Date().getFullYear() + 1, 0, 1);
export const exampleOutput = getCountdown(newYear, "New Year").formatted;
`;
  }

  if (lowerPrompt.includes("format") || lowerPrompt.includes("display")) {
    return `import { format, formatDistance, formatRelative, isToday, isYesterday, isTomorrow } from "date-fns";

export interface FormattedDate {
  full: string;
  short: string;
  relative: string;
  friendly: string;
}

export function formatDateMultipleWays(date: Date): FormattedDate {
  const now = new Date();
  
  let friendly: string;
  if (isToday(date)) {
    friendly = "Today";
  } else if (isYesterday(date)) {
    friendly = "Yesterday";
  } else if (isTomorrow(date)) {
    friendly = "Tomorrow";
  } else {
    friendly = formatRelative(date, now);
  }
  
  return {
    full: format(date, "EEEE, MMMM do, yyyy 'at' h:mm a"),
    short: format(date, "MM/dd/yyyy"),
    relative: formatDistance(date, now, { addSuffix: true }),
    friendly,
  };
}

// Example
const result = formatDateMultipleWays(new Date());
export const exampleOutput = \`Full: \${result.full}\\nShort: \${result.short}\\nRelative: \${result.relative}\\nFriendly: \${result.friendly}\`;
`;
  }

  // Default: date range utilities
  return `import { eachDayOfInterval, format, isWeekend, startOfWeek, endOfWeek, addWeeks } from "date-fns";

export interface WeekSummary {
  weekStart: string;
  weekEnd: string;
  weekdays: string[];
  weekendDays: string[];
}

export function getWeekSummary(date: Date): WeekSummary {
  const start = startOfWeek(date, { weekStartsOn: 1 }); // Monday
  const end = endOfWeek(date, { weekStartsOn: 1 });
  
  const days = eachDayOfInterval({ start, end });
  const weekdays = days.filter(d => !isWeekend(d)).map(d => format(d, "EEE MMM d"));
  const weekendDays = days.filter(d => isWeekend(d)).map(d => format(d, "EEE MMM d"));
  
  return {
    weekStart: format(start, "MMM d"),
    weekEnd: format(end, "MMM d"),
    weekdays,
    weekendDays,
  };
}

// Example
const result = getWeekSummary(new Date());
export const exampleOutput = \`This week: \${result.weekStart} - \${result.weekEnd}\\nWeekdays: \${result.weekdays.join(", ")}\\nWeekend: \${result.weekendDays.join(", ")}\`;
`;
}
