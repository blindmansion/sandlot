import {
	WEEKDAY_LABELS,
	formatWeekRange,
	fromISODate,
	isSameISODay,
	toISODate,
	weekDays,
} from "../dateUtils";

export interface WeekCalendarProps {
	weekAnchor: string;
	selectedDate: string;
	countsByDate: Record<string, number>;
	onSelect: (iso: string) => void;
	onPrevWeek: () => void;
	onNextWeek: () => void;
	onToday: () => void;
}

export function WeekCalendar({
	weekAnchor,
	selectedDate,
	countsByDate,
	onSelect,
	onPrevWeek,
	onNextWeek,
	onToday,
}: WeekCalendarProps) {
	const days = weekDays(fromISODate(weekAnchor));
	const todayIso = toISODate(new Date());

	return (
		<section className="calendar">
			<div className="calendar__bar">
				<button type="button" className="calendar__nav" onClick={onPrevWeek} aria-label="Previous week">
					‹
				</button>
				<span className="calendar__range">{formatWeekRange(fromISODate(weekAnchor))}</span>
				<button type="button" className="calendar__nav" onClick={onNextWeek} aria-label="Next week">
					›
				</button>
				<button type="button" className="calendar__today" onClick={onToday}>
					Today
				</button>
			</div>

			<div className="calendar__grid">
				{days.map((day, i) => {
					const iso = toISODate(day);
					const count = countsByDate[iso] ?? 0;
					const classes = ["day-cell"];
					if (iso === selectedDate) classes.push("day-cell--selected");
					if (isSameISODay(day, todayIso)) classes.push("day-cell--today");
					return (
						<button
							type="button"
							key={iso}
							className={classes.join(" ")}
							onClick={() => onSelect(iso)}
						>
							<span className="day-cell__label">{WEEKDAY_LABELS[i]}</span>
							<span className="day-cell__num">{day.getDate()}</span>
							{count > 0 && <span className="day-cell__badge">{count}</span>}
						</button>
					);
				})}
			</div>
		</section>
	);
}
