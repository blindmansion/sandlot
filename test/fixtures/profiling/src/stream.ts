import { filter, firstValueFrom, from, map, toArray } from "rxjs";
import type { User } from "./schema";

/** Exercises rxjs's operator type overloads through `pipe`. */
export async function adultNames(users: User[]): Promise<string[]> {
	return firstValueFrom(
		from(users).pipe(
			filter((u) => u.age >= 18),
			map((u) => u.name.trim()),
			toArray(),
		),
	);
}
